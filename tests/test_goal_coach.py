"""Tests for the goal coach AI Task adapters."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.machbar.const import DOMAIN
from custom_components.machbar.goal_coach import (
    GOAL_ASSESS_STRUCTURE,
    GOAL_SUGGEST_STRUCTURE,
    async_analyze_goal_assess,
    async_analyze_goal_suggest,
    normalize_goal_assess_response,
)
from custom_components.machbar.intake import AdapterError
from custom_components.machbar.worker import RequestWorker


async def test_goal_suggest_uses_payload_prompt_and_normalizes(hass):
    generate = AsyncMock(
        return_value=SimpleNamespace(
            data={
                "interventions": [
                    {
                        "type": "frequency_habit",
                        "commitment": "  If I finish work, then I walk. ",
                        "rationale": "  Small and observable. ",
                        "startDate": "2026-10-15",
                        "revisitDate": "2026-10-29",
                    }
                ]
            }
        )
    )
    with patch(
        "custom_components.machbar.goal_coach.ai_task_capabilities",
        return_value={"state": "ok"},
    ), patch("homeassistant.components.ai_task.task.async_generate_data", generate):
        result = await async_analyze_goal_suggest(
            hass,
            "ai_task.test",
            {"taskName": "Machbar Zielcoach", "instructions": "Use this prompt"},
        )

    assert result["interventions"][0]["commitment"] == "If I finish work, then I walk."
    assert generate.await_args.kwargs["instructions"] == "Use this prompt"
    assert generate.await_args.kwargs["structure"] is GOAL_SUGGEST_STRUCTURE


async def test_goal_assess_filters_counted_ids_to_candidates(hass):
    generate = AsyncMock(
        return_value=SimpleNamespace(
            data={
                "band": "mostly_achieved",
                "rationaleMd": "  Evidence supports a partial result. ",
                "countedItemIds": [7, 999],
                "nextMove": "  Continue once more. ",
            }
        )
    )
    with patch(
        "custom_components.machbar.goal_coach.ai_task_capabilities",
        return_value={"state": "ok"},
    ), patch("homeassistant.components.ai_task.task.async_generate_data", generate):
        result = await async_analyze_goal_assess(
            hass,
            "ai_task.test",
            {
                "taskName": "Machbar Zielcoach",
                "instructions": "Review the digest",
                "candidateItemIds": [7, 8],
            },
        )

    assert result == {
        "band": "mostly_achieved",
        "rationaleMd": "Evidence supports a partial result.",
        "countedItemIds": [7],
        "nextMove": "Continue once more.",
    }
    assert generate.await_args.kwargs["structure"] is GOAL_ASSESS_STRUCTURE


@pytest.mark.parametrize(
    "data",
    [
        None,
        {},
        {"interventions": [{"type": "frequency_habit"}]},
    ],
)
def test_goal_suggest_rejects_malformed_output(data):
    with pytest.raises(AdapterError) as err:
        from custom_components.machbar.goal_coach import normalize_goal_suggest_response

        normalize_goal_suggest_response(data)
    assert err.value.code == "ai_task_invalid_response"


def test_goal_assess_rejects_malformed_output():
    with pytest.raises(AdapterError) as err:
        normalize_goal_assess_response(
            {
                "band": "achieved",
                "rationaleMd": "Good",
                "countedItemIds": ["7"],
            },
            [7],
        )
    assert err.value.code == "ai_task_invalid_response"


async def test_goal_coach_requires_configured_ai_task(hass):
    with patch(
        "custom_components.machbar.goal_coach.ai_task_capabilities",
        return_value={"state": "missing"},
    ), pytest.raises(AdapterError) as err:
        await async_analyze_goal_suggest(hass, None, {})
    assert err.value.code == "ai_task_not_configured"


async def test_worker_dispatches_goal_coach_requests(hass):
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"origin": "http://x", "token": "t"},
        options={"ai_task_entity_id": "ai_task.test"},
    )
    with patch("custom_components.machbar.async_get_clientsession", return_value=object()):
        worker = RequestWorker(hass, entry)
    worker.client.complete_request = AsyncMock()
    result = {
        "band": "achieved",
        "rationaleMd": "Good evidence.",
        "countedItemIds": [7],
        "nextMove": "Continue.",
    }
    with patch(
        "custom_components.machbar.worker.async_analyze_goal_assess",
        AsyncMock(return_value=result),
    ) as analyze:
        await worker._handle(
            {
                "id": "assessment",
                "kind": "goal_assess",
                "payload": {"instructions": "Review", "candidateItemIds": [7]},
                "leaseToken": "lease",
            }
        )
    assert analyze.await_args.args[1:] == ("ai_task.test", {"instructions": "Review", "candidateItemIds": [7]})
    worker.client.complete_request.assert_awaited_once_with(
        "assessment",
        {"leaseToken": "lease", "outcome": "succeeded", "result": result},
    )
