"""Compatibility checks against Home Assistant Core 2026.10 structured output."""

from importlib.metadata import version

import pytest
import probatio
from probatio import to_openapi

from custom_components.machbar.intake import WORK_REFINEMENT_STRUCTURE
from tests.test_intake import _probatio_schema_from_voluptuous


pytestmark = pytest.mark.ha_2026_10


def test_work_refinement_schema_survives_real_ha_2026_10_adjustment():
    """Run this test in HA 2026.10.0 with its pinned Probatio 0.13.0."""
    if version("probatio") != "0.13.0":
        pytest.skip("requires Home Assistant 2026.10.0's Probatio 0.13.0 environment")

    from homeassistant.components.openai_conversation.schema import adjust_schema

    converted = to_openapi(
        _probatio_schema_from_voluptuous(WORK_REFINEMENT_STRUCTURE),
        openapi_version="3.1.0",
    )
    adjust_schema(converted)

    assert converted["type"] == "object"
    assert "anyOf" not in converted
    variants = converted["properties"]["changes"]["items"]["anyOf"]
    assert len(variants) == 9
    assert all(variant["additionalProperties"] is False for variant in variants)

    by_kind = {
        variant["properties"]["kind"]["enum"][0]: variant
        for variant in variants
    }
    assert by_kind["update_project_outcome"]["properties"].keys() >= {
        "kind", "rationale", "accepted", "projectId", "criterionId", "outcome"
    }
    assert not {"title", "notes", "position"} & by_kind["update_project_outcome"]["properties"].keys()
    assert not {"title", "notes"} & by_kind["convert_task_to_project"]["properties"].keys()
    assert by_kind["add_dependency"]["properties"]["taskId"]["type"] == "integer"
    assert by_kind["add_dependency"]["properties"]["dependsOnTaskId"]["type"] == "integer"
    assert by_kind["move_task"]["properties"]["parentTaskId"]["anyOf"]
    assert by_kind["move_task"]["properties"]["projectId"]["anyOf"]

    validator = probatio.from_json_schema(converted)
    validator({
        "intent": "structure",
        "summary": "Typed alternatives",
        "disposition": "changes",
        "question": None,
        "changes": [
            {
                "kind": "update_task", "rationale": "Clarify.", "accepted": None,
                "targetId": 1, "title": "Task", "notes": None,
            },
            {
                "kind": "update_project", "rationale": "Clarify.", "accepted": None,
                "targetId": 2, "title": None, "notes": "Notes",
            },
            {
                "kind": "convert_task_to_project", "rationale": "Group work.", "accepted": None,
                "targetId": 3,
            },
            {
                "kind": "create_child", "rationale": "Advance.", "accepted": None,
                "parentTaskId": 2, "title": "Child", "notes": None,
            },
            {
                "kind": "move_task", "rationale": "Reorder.", "accepted": None,
                "targetId": 4, "parentTaskId": None, "projectId": 2, "position": 0,
            },
            {
                "kind": "add_dependency", "rationale": "Order work.", "accepted": None,
                "taskId": 4, "dependsOnTaskId": 5,
            },
            {
                "kind": "update_wait", "rationale": "Clarify wait.", "accepted": None,
                "taskId": 6, "waitingFor": "Reply", "revisitAt": None,
            },
            {
                "kind": "update_project_outcome", "rationale": "Make done visible.", "accepted": None,
                "projectId": 2, "criterionId": None, "outcome": "Visible result",
            },
            {
                "kind": "advisory", "rationale": "Consider.", "accepted": None,
                "affectedIds": [2, 4], "title": "Review",
            },
        ],
    })
