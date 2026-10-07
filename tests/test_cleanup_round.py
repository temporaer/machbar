"""Tests for the Klärungsrunde AI Task adapter."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
import voluptuous as vol
from probatio import to_openapi
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.machbar.cleanup_round import (
    CLEANUP_ROUND_STRUCTURE,
    async_analyze_cleanup_round,
    normalize_cleanup_response,
)
from custom_components.machbar.const import DOMAIN
from custom_components.machbar.intake import AdapterError
from custom_components.machbar.worker import RequestWorker
from tests.test_intake import _ha_2026_9_3_adjust_schema, _probatio_schema_from_voluptuous


def _valid_result(**overrides):
    return {
        "targetType": "task",
        "targetId": 7,
        "proposal": "identify_first_slice",
        "resolutionSurface": "create_first_slice",
        "inferredWorkType": "debt",
        "inferredFlow": "uphill",
        "confidence": "medium",
        "reason": "Zu breit.",
        "question": "Welcher Bereich zuerst?",
        "suggestedDefault": "Werkzeugecke sortieren",
        "suggestedTitle": None,
        "suggestedShape": None,
        **overrides,
    }


def test_structure_only_enforces_the_envelope():
    response = {"summary": "Runde", "results": [_valid_result()], "warnings": []}
    assert CLEANUP_ROUND_STRUCTURE(response)["results"][0]["targetId"] == 7
    # Unknown vocabulary values pass through; Machbar's API validates them.
    loose = CLEANUP_ROUND_STRUCTURE({
        **response,
        "results": [
            _valid_result(
                proposal="plan_everything",
                resolutionSurface="auto_apply",
                inferredWorkType="chore",
                inferredFlow="sideways",
                confidence="certain",
                targetType="story",
                suggestedShape="checklist",
            )
        ],
    })
    assert loose["results"][0]["proposal"] == "plan_everything"
    assert loose["results"][0]["suggestedShape"] == "checklist"
    # Extra result keys are tolerated and dropped.
    extra = CLEANUP_ROUND_STRUCTURE({**response, "results": [{**_valid_result(), "plan": ["a"]}]})
    assert "plan" not in extra["results"][0]
    with pytest.raises(vol.Invalid):
        CLEANUP_ROUND_STRUCTURE({"summary": "Runde", "warnings": []})
    with pytest.raises(vol.Invalid):
        CLEANUP_ROUND_STRUCTURE({**response, "results": {}})


def test_structure_converts_to_a_strict_provider_safe_schema():
    converted = to_openapi(_probatio_schema_from_voluptuous(CLEANUP_ROUND_STRUCTURE))
    _ha_2026_9_3_adjust_schema(converted)
    result = converted["properties"]["results"]["items"]
    # No closed enums at the HA boundary, but the vocabulary guides the model.
    for field in ("targetType", "proposal", "resolutionSurface", "inferredWorkType", "inferredFlow", "confidence"):
        assert "enum" not in result["properties"][field]
    assert "leave_alone" in result["properties"]["proposal"]["description"]
    assert "open_item" in result["properties"]["resolutionSurface"]["description"]
    # Strict structured-output providers require closed objects.
    assert result["additionalProperties"] is False
    assert converted["additionalProperties"] is False
    assert set(result["required"]) >= {"targetType", "targetId", "proposal", "resolutionSurface"}


def test_normalize_strips_strings_coerces_ids_and_drops_unknown_keys():
    normalized = normalize_cleanup_response({
        "summary": "  Runde  ",
        "results": [
            {**_valid_result(targetId="7", reason="  Zu breit. "), "plan": ["a", "b"]},
            "not an object",
        ],
        "warnings": [{"message": " Hinweis "}, "ignored"],
    })
    assert normalized["summary"] == "Runde"
    assert normalized["results"][0]["targetId"] == 7
    assert normalized["results"][0]["reason"] == "Zu breit."
    assert "plan" not in normalized["results"][0]
    assert normalized["results"][1] == "not an object"
    assert normalized["warnings"] == [{"message": "Hinweis"}]


@pytest.mark.parametrize("data", [None, [], {"summary": "x"}, {"results": {}}])
def test_normalize_rejects_unusable_envelopes(data):
    with pytest.raises(AdapterError) as err:
        normalize_cleanup_response(data)
    assert err.value.code == "ai_task_invalid_response"


async def test_analyze_uses_payload_instructions_and_structure(hass):
    generate = AsyncMock(return_value=SimpleNamespace(data={"summary": "ok", "results": [], "warnings": []}))
    with patch(
        "custom_components.machbar.cleanup_round.ai_task_capabilities",
        return_value={"state": "ok"},
    ), patch("homeassistant.components.ai_task.task.async_generate_data", generate):
        result = await async_analyze_cleanup_round(
            hass, "ai_task.test", {"taskName": "Machbar Klärungsrunde", "instructions": "Coach"}
        )
    assert result == {"summary": "ok", "results": [], "warnings": []}
    kwargs = generate.await_args.kwargs
    assert kwargs["instructions"] == "Coach"
    assert kwargs["structure"] is CLEANUP_ROUND_STRUCTURE


async def test_analyze_requires_configured_ai_task(hass):
    with patch(
        "custom_components.machbar.cleanup_round.ai_task_capabilities",
        return_value={"state": "missing"},
    ), pytest.raises(AdapterError) as err:
        await async_analyze_cleanup_round(hass, None, {})
    assert err.value.code == "ai_task_not_configured"


async def test_worker_dispatches_cleanup_round_requests(hass):
    entry = MockConfigEntry(
        domain=DOMAIN, data={"origin": "http://x", "token": "t"}, options={"ai_task_entity_id": "ai_task.test"}
    )
    with patch("custom_components.machbar.async_get_clientsession", return_value=object()):
        worker = RequestWorker(hass, entry)
    worker.client.complete_request = AsyncMock()
    analyzed = {"summary": "ok", "results": [], "warnings": []}
    with patch(
        "custom_components.machbar.worker.async_analyze_cleanup_round",
        AsyncMock(return_value=analyzed),
    ) as analyze:
        await worker._handle({
            "id": "round",
            "kind": "cleanup_round_analyze",
            "payload": {"instructions": "Coach"},
            "leaseToken": "lease",
        })
    assert analyze.await_args.args[1:] == ("ai_task.test", {"instructions": "Coach"})
    worker.client.complete_request.assert_awaited_once_with(
        "round", {"leaseToken": "lease", "outcome": "succeeded", "result": analyzed}
    )
