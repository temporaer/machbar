"""Tests for the AI Task adapter."""

import json
from pathlib import Path
from importlib.metadata import version
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
import voluptuous as vol
from probatio import Any as ProbatioAny
from probatio import In as ProbatioIn
from probatio import Optional as ProbatioOptional
from probatio import Required as ProbatioRequired
from probatio import Schema as ProbatioSchema
from probatio import to_openapi

from custom_components.machbar.intake import (
    INTAKE_STRUCTURE,
    WORK_REFINEMENT_STRUCTURE,
    AdapterError,
    async_analyze,
    normalize_plan,
)


def _probatio_schema_from_voluptuous(schema):
    if isinstance(schema, vol.Schema):
        return ProbatioSchema(
            _probatio_schema_from_voluptuous(schema.schema),
            required=schema.required,
            extra=schema.extra,
        )
    if isinstance(schema, dict):
        converted = {}
        for marker, validator in schema.items():
            if isinstance(marker, vol.Marker):
                marker_type = (
                    ProbatioRequired if isinstance(marker, vol.Required) else ProbatioOptional
                )
                marker = marker_type(
                    marker.schema,
                    default=getattr(marker, "default", ...),
                    description=getattr(marker, "description", None),
                )
            converted[marker] = _probatio_schema_from_voluptuous(validator)
        return converted
    if isinstance(schema, list):
        return [_probatio_schema_from_voluptuous(item) for item in schema]
    if isinstance(schema, vol.Any):
        return ProbatioAny(
            *(_probatio_schema_from_voluptuous(item) for item in schema.validators)
        )
    if isinstance(schema, vol.In):
        return ProbatioIn(schema.container)
    return schema


def _ha_2026_9_3_adjust_schema(schema):
    """Test-only reproduction of HA Core 2026.9.3's OpenAI schema adjustment."""
    if schema["type"] == "object":
        schema.setdefault("strict", True)
        schema.setdefault("additionalProperties", False)
        if "properties" not in schema:
            return
        schema.setdefault("required", [])
        for name, property_schema in schema["properties"].items():
            _ha_2026_9_3_adjust_schema(property_schema)
            if name not in schema["required"]:
                property_schema["type"] = [property_schema["type"], "null"]
                schema["required"].append(name)
    elif schema["type"] == "array" and "items" in schema:
        _ha_2026_9_3_adjust_schema(schema["items"])


def test_generation_schema_matches_ha_2026_9_3_openai_conversion_fixture():
    fixture_path = Path(__file__).parent / "fixtures/ha-2026.9.3-openai-intake-converted-schema.json"
    fixture = json.loads(fixture_path.read_text())
    assert fixture["haCoreVersion"] == "2026.9.3"
    assert fixture["probatioVersion"] == "0.11.4"
    assert version("probatio") == fixture["probatioVersion"]
    converted = to_openapi(_probatio_schema_from_voluptuous(INTAKE_STRUCTURE))
    _ha_2026_9_3_adjust_schema(converted)
    assert converted == fixture["convertedSchema"]

    calendar = converted["properties"]["calendarEvents"]["items"]
    work = converted["properties"]["workItems"]["items"]
    for schema, fields in (
        (converted, ("calendarEvents", "workItems", "warnings")),
        (calendar, ("allDay", "relatedWorkKeys")),
        (work, ("needsClarification", "reminders", "relatedCalendarKeys")),
    ):
        for name in fields:
            assert name in schema["required"]
            field_type = schema["properties"][name]["type"]
            assert "null" not in field_type if isinstance(field_type, list) else field_type != "null"
    assert calendar["properties"]["allDay"]["type"] == "boolean"
    assert work["properties"]["needsClarification"]["type"] == "boolean"
    for nullable_scalar in (
        calendar["properties"]["description"],
        work["properties"]["notes"],
        work["properties"]["ownerName"],
        work["properties"]["dueDate"],
    ):
        assert "null" in nullable_scalar["type"]


def _valid_plan():
    return {
        "summary": "Plan",
        "calendarEvents": [
            {
                "key": "calendar-1",
                "title": "Appointment",
                "description": None,
                "location": None,
                "allDay": True,
                "startDate": "2026-09-29",
                "endDate": "2026-09-30",
                "startDateTime": None,
                "endDateTime": None,
                "relatedWorkKeys": ["work-1"],
            }
        ],
        "workItems": [
            {
                "key": "work-1",
                "kind": "action",
                "title": "Prepare",
                "notes": None,
                "parentKey": None,
                "ownerName": None,
                "dueDate": None,
                "scheduledDate": "2026-09-29",
                "revisitAt": None,
                "notBeforeDate": None,
                "notBeforeAt": None,
                "reminders": [],
                "needsClarification": False,
                "relatedCalendarKeys": ["calendar-1"],
            }
        ],
        "warnings": [{"message": "Check the date"}],
    }


@pytest.mark.parametrize(
    ("object_path", "unknown_key"),
    [
        ((), "rootExtra"),
        (("calendarEvents", 0), "calendarExtra"),
        (("workItems", 0), "workExtra"),
        (("warnings", 0), "warningExtra"),
    ],
)
def test_intake_structure_rejects_unknown_properties(object_path, unknown_key):
    plan = _valid_plan()
    target = plan
    for part in object_path:
        target = target[part]
    target[unknown_key] = True

    with pytest.raises(vol.MultipleInvalid):
        INTAKE_STRUCTURE(plan)


def test_normalize_plan_drops_unknown_keys():
    plan = normalize_plan(
        {
            "summary": " hello ",
            "calendarEvents": [],
            "workItems": [],
            "warnings": [],
            "unexpected": True,
        }
    )
    assert plan == {"summary": "hello", "calendarEvents": [], "workItems": [], "warnings": []}


@pytest.mark.parametrize("field", ["calendarEvents", "workItems", "warnings"])
def test_normalize_plan_defaults_omitted_collections(field):
    normalized = normalize_plan({"summary": "Plan"})

    assert normalized[field] == []


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("calendarEvents", {}),
        ("calendarEvents", "not-an-array"),
        ("workItems", {}),
        ("workItems", "not-an-array"),
        ("warnings", {}),
        ("warnings", "not-an-array"),
    ],
)
def test_normalize_plan_preserves_wrong_type_collections_as_diagnostics(field, value):
    with pytest.raises(AdapterError) as err:
        normalize_plan({"summary": "Plan", field: value})

    assert err.value.details["path"] == [field]


def test_normalize_plan_defaults_null_collections_and_item_fields():
    normalized = normalize_plan({
        "summary": "Plan",
        "calendarEvents": [{
            "key": "event",
            "title": "Event",
            "allDay": None,
            "relatedWorkKeys": None,
        }, {
            "key": "event-defaults",
            "title": "Event defaults",
        }],
        "workItems": [{
            "key": "action",
            "kind": "action",
            "title": "Action",
            "needsClarification": None,
            "reminders": None,
            "relatedCalendarKeys": None,
        }],
        "warnings": None,
    })

    assert normalized["warnings"] == []
    assert normalized["calendarEvents"][0]["allDay"] is False
    assert normalized["calendarEvents"][0]["relatedWorkKeys"] == []
    assert normalized["calendarEvents"][1]["allDay"] is False
    assert normalized["calendarEvents"][1]["relatedWorkKeys"] == []
    assert normalized["workItems"][0]["needsClarification"] is False
    assert normalized["workItems"][0]["reminders"] == []
    assert normalized["workItems"][0]["relatedCalendarKeys"] == []
    assert normalize_plan({
        "summary": "Plan",
        "calendarEvents": None,
        "workItems": None,
        "warnings": None,
    }) == {"summary": "Plan", "calendarEvents": [], "workItems": [], "warnings": []}


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("calendarEvents", 0, "allDay"), 0),
        (("calendarEvents", 0, "relatedWorkKeys"), "[]"),
        (("workItems", 0, "needsClarification"), "false"),
        (("workItems", 0, "reminders"), {}),
        (("workItems", 0, "relatedCalendarKeys"), 0),
    ],
)
def test_normalize_plan_rejects_wrong_non_null_required_field_types(path, value):
    plan = _valid_plan()
    target = plan
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value

    with pytest.raises(AdapterError) as err:
        normalize_plan(plan)

    assert err.value.details["path"] == list(path)


@pytest.mark.parametrize("value", ["missing", None, False, True])
def test_normalize_plan_defaults_or_preserves_clarification(value):
    plan = _valid_plan()
    if value == "missing":
        del plan["workItems"][0]["needsClarification"]
    else:
        plan["workItems"][0]["needsClarification"] = value

    normalized = normalize_plan(plan)

    assert normalized["workItems"][0]["needsClarification"] is (
        value is True
    )


@pytest.mark.parametrize("value", ["missing", None, []])
def test_normalize_plan_defaults_or_preserves_empty_reminders(value):
    plan = _valid_plan()
    if value == "missing":
        del plan["workItems"][0]["reminders"]
    else:
        plan["workItems"][0]["reminders"] = value

    assert normalize_plan(plan)["workItems"][0]["reminders"] == []


def test_normalize_plan_handles_flower_watering_compact_input():
    normalized = normalize_plan(
        {
            "summary": "Blumenpflege",
            "workItems": [{
                "key": "water-flowers",
                "kind": "action",
                "title": "Blumen gießen",
                "notes": ".",
                "parentKey": ".",
                "ownerName": ".",
                "dueDate": ".",
                "scheduledDate": "2026-10-03",
                "notBeforeDate": ".",
                "notBeforeAt": ".",
                "reminders": [{
                    "kind": "absolute",
                    "at": "2026-10-03T08:00:00+02:00",
                }],
            }],
        }
    )

    assert normalized["workItems"] == [{
        "key": "water-flowers",
        "kind": "action",
        "title": "Blumen gießen",
        "notes": ".",
        "parentKey": None,
        "ownerName": None,
        "dueDate": None,
        "scheduledDate": "2026-10-03",
        "revisitAt": None,
        "notBeforeDate": None,
        "notBeforeAt": None,
        "reminders": [{
            "kind": "absolute",
            "at": "2026-10-03T08:00:00+02:00",
        }],
        "needsClarification": False,
        "relatedCalendarKeys": [],
    }]


def test_normalize_plan_clears_datetimes_for_all_day_events():
    plan = _valid_plan()
    event = plan["calendarEvents"][0]
    event["startDateTime"] = "2026-09-29T10:00:00+02:00"
    event["endDateTime"] = "2026-09-29T11:00:00+02:00"

    normalized = normalize_plan(plan)
    normalized_event = normalized["calendarEvents"][0]

    assert normalized_event["allDay"] is True
    assert normalized_event["startDate"] == "2026-09-29"
    assert normalized_event["endDate"] == "2026-09-30"
    assert normalized_event["startDateTime"] is None
    assert normalized_event["endDateTime"] is None
    INTAKE_STRUCTURE(normalized)


def test_normalize_plan_discards_project_task_fields_with_one_warning():
    normalized = normalize_plan({
        "summary": "Plan",
        "workItems": [{
            "key": "garden",
            "kind": "project",
            "title": "Garden",
            "dueDate": "2026-10-10",
            "scheduledDate": "2026-10-05",
            "notBeforeDate": 42,
            "reminders": {"malformed": True},
            "needsClarification": True,
        }],
    })

    project = normalized["workItems"][0]
    assert project["dueDate"] == "2026-10-10"
    assert project["scheduledDate"] == "2026-10-05"
    assert project["notBeforeDate"] is None
    assert project["reminders"] == []
    assert project["needsClarification"] is False
    assert normalized["warnings"] == [
        {"message": "Ignored task-only fields on project 'garden'."},
    ]


def test_normalize_plan_ignores_default_project_task_fields_without_warning():
    normalized = normalize_plan({
        "summary": "Plan",
        "workItems": [{
            "key": "garden",
            "kind": "project",
            "title": "Garden",
            "notBeforeDate": None,
            "notBeforeAt": None,
            "reminders": [],
            "needsClarification": False,
        }],
    })

    assert normalized["warnings"] == []


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("notBeforeDate", False),
        ("notBeforeAt", False),
        ("reminders", False),
        ("needsClarification", False),
    ],
)
def test_normalize_plan_discards_false_project_task_fields_without_warning(field, value):
    normalized = normalize_plan({
        "summary": "Plan",
        "workItems": [{
            "key": "garden",
            "kind": "project",
            "title": "Garden",
            field: value,
        }],
    })

    assert normalized["workItems"][0] == {
        "key": "garden",
        "kind": "project",
        "title": "Garden",
        "notes": None,
        "parentKey": None,
        "ownerName": None,
        "dueDate": None,
        "scheduledDate": None,
        "revisitAt": None,
        "notBeforeDate": None,
        "notBeforeAt": None,
        "reminders": [],
        "needsClarification": False,
        "relatedCalendarKeys": [],
    }
    assert normalized["warnings"] == []


def test_normalize_plan_discards_mixed_project_task_fields_with_one_warning():
    normalized = normalize_plan({
        "summary": "Plan",
        "workItems": [{
            "key": "garden",
            "kind": "project",
            "title": "Garden",
            "notBeforeDate": "2026-10-10",
            "notBeforeAt": False,
            "reminders": [],
            "needsClarification": False,
        }],
    })

    item = normalized["workItems"][0]
    assert item["notBeforeDate"] is None
    assert item["notBeforeAt"] is None
    assert item["reminders"] == []
    assert item["needsClarification"] is False
    assert normalized["warnings"] == [
        {"message": "Ignored task-only fields on project 'garden'."},
    ]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("notBeforeDate", False),
        ("notBeforeAt", False),
        ("reminders", False),
    ],
)
def test_normalize_plan_still_rejects_false_task_only_values_on_actions(field, value):
    plan = _valid_plan()
    plan["workItems"][0][field] = value

    with pytest.raises(AdapterError) as err:
        normalize_plan(plan)

    assert err.value.details["path"] == ["workItems", 0, field]


def test_normalize_plan_preserves_reminders_on_clarifying_actions():
    plan = _valid_plan()
    plan["workItems"][0]["needsClarification"] = True
    plan["workItems"][0]["reminders"] = [{
        "kind": "absolute",
        "at": "2026-09-30T08:00:00+02:00",
    }]

    normalized = normalize_plan(plan)

    assert normalized["workItems"][0]["needsClarification"] is True
    assert normalized["workItems"][0]["reminders"] == plan["workItems"][0]["reminders"]


def test_normalize_plan_clears_dates_for_timed_events():
    plan = _valid_plan()
    event = plan["calendarEvents"][0]
    event["allDay"] = False
    event["startDateTime"] = "2026-09-29T10:00:00+02:00"
    event["endDateTime"] = "2026-09-29T11:00:00+02:00"

    normalized = normalize_plan(plan)
    normalized_event = normalized["calendarEvents"][0]

    assert normalized_event["allDay"] is False
    assert normalized_event["startDate"] is None
    assert normalized_event["endDate"] is None
    assert normalized_event["startDateTime"] == "2026-09-29T10:00:00+02:00"
    assert normalized_event["endDateTime"] == "2026-09-29T11:00:00+02:00"
    INTAKE_STRUCTURE(normalized)


_NULLABLE_WORK_FIELDS = (
    "parentKey",
    "ownerName",
    "dueDate",
    "scheduledDate",
    "notBeforeDate",
    "notBeforeAt",
)
_NULLABLE_CALENDAR_FIELDS = (
    "startDate",
    "endDate",
    "startDateTime",
    "endDateTime",
)


@pytest.mark.parametrize("blank", ["", "   ", "\t\n "])
def test_normalize_plan_turns_blank_nullable_strings_into_none(blank):
    plan = _valid_plan()
    for field in _NULLABLE_CALENDAR_FIELDS:
        plan["calendarEvents"][0][field] = blank
    for field in _NULLABLE_WORK_FIELDS:
        plan["workItems"][0][field] = blank

    normalized = normalize_plan(plan)

    for field in _NULLABLE_CALENDAR_FIELDS:
        assert normalized["calendarEvents"][0][field] is None
    for field in _NULLABLE_WORK_FIELDS:
        assert normalized["workItems"][0][field] is None


@pytest.mark.parametrize("placeholder", ["null", "NULL", "None", " NONE "])
def test_normalize_plan_turns_exact_nullable_placeholders_into_none(placeholder):
    plan = _valid_plan()
    for field in _NULLABLE_CALENDAR_FIELDS:
        plan["calendarEvents"][0][field] = placeholder
    for field in _NULLABLE_WORK_FIELDS:
        plan["workItems"][0][field] = placeholder

    normalized = normalize_plan(plan)

    for field in _NULLABLE_CALENDAR_FIELDS:
        assert normalized["calendarEvents"][0][field] is None
    for field in _NULLABLE_WORK_FIELDS:
        assert normalized["workItems"][0][field] is None


def test_normalize_plan_preserves_free_text_placeholders():
    plan = _valid_plan()
    plan["calendarEvents"][0]["description"] = "null"
    plan["calendarEvents"][0]["location"] = "None"
    plan["workItems"][0]["notes"] = " NULL "

    normalized = normalize_plan(plan)

    assert normalized["calendarEvents"][0]["description"] == "null"
    assert normalized["calendarEvents"][0]["location"] == "None"
    assert normalized["workItems"][0]["notes"] == "NULL"


def test_normalize_plan_reports_bounded_contract_type_details():
    plan = _valid_plan()
    plan["workItems"][0]["dueDate"] = 42

    with pytest.raises(AdapterError) as err:
        normalize_plan(plan)

    assert err.value.details == {
        "path": ["workItems", 0, "dueDate"],
        "expectedType": "a string or null",
        "actualType": "int",
    }


def test_normalize_plan_trims_non_empty_nullable_strings():
    plan = _valid_plan()
    plan["workItems"][0]["notes"] = "  bring cake \n"
    plan["workItems"][0]["ownerName"] = " Anna "
    plan["workItems"][0]["dueDate"] = " 2026-09-30 "
    plan["calendarEvents"][0]["location"] = "\tSchool "

    normalized = normalize_plan(plan)

    assert normalized["workItems"][0]["notes"] == "bring cake"
    assert normalized["workItems"][0]["ownerName"] == "Anna"
    assert normalized["workItems"][0]["dueDate"] == "2026-09-30"
    assert normalized["calendarEvents"][0]["location"] == "School"


@pytest.mark.parametrize(
    ("object_path", "field"),
    [
        (("workItems", 0), "key"),
        (("workItems", 0), "title"),
        (("calendarEvents", 0), "key"),
        (("calendarEvents", 0), "title"),
        (("warnings", 0), "message"),
    ],
)
@pytest.mark.parametrize("bad_value", [None, 42, "MISSING"])
def test_normalize_plan_rejects_missing_or_non_string_required_values(object_path, field, bad_value):
    plan = _valid_plan()
    target = plan
    for part in object_path:
        target = target[part]
    if bad_value == "MISSING":
        del target[field]
    else:
        target[field] = bad_value

    with pytest.raises(AdapterError) as err:
        normalize_plan(plan)
    assert err.value.code == "ai_task_invalid_response"


def test_normalize_plan_keeps_blank_required_strings_as_strings():
    plan = _valid_plan()
    plan["summary"] = "   "
    plan["workItems"][0]["title"] = "  "

    normalized = normalize_plan(plan)

    assert normalized["summary"] == ""
    assert normalized["workItems"][0]["title"] == ""


def test_normalize_plan_normalizes_empty_strings_on_action_and_reference():
    empty_fields = {
        "notes": " ",
        "parentKey": "",
        "ownerName": "",
        "dueDate": "",
        "scheduledDate": "",
        "notBeforeDate": "",
        "notBeforeAt": "",
        "reminders": [],
    }
    plan = {
        "summary": "Plan",
        "calendarEvents": [],
        "workItems": [
            {
                "key": "buy-cake",
                "kind": "action",
                "title": "Buy cake",
                **empty_fields,
                "needsClarification": False,
                "relatedCalendarKeys": [],
            },
            {
                "key": "menu",
                "kind": "reference",
                "title": "School menu",
                **empty_fields,
                "needsClarification": False,
                "relatedCalendarKeys": [],
            },
        ],
        "warnings": [],
    }

    normalized = normalize_plan(plan)

    assert [item["kind"] for item in normalized["workItems"]] == ["action", "reference"]
    nullable_fields = set(empty_fields) - {"reminders", "notes"}
    for item in normalized["workItems"]:
        for field in nullable_fields:
            assert item[field] is None
        assert item["notes"] == ""
        assert item["reminders"] == []
    INTAKE_STRUCTURE(normalized)


def test_normalize_plan_matches_shared_nullable_placeholder_fixture():
    fixture = Path(__file__).resolve().parents[1] / "packages/shared/fixtures/intake-plan/nullable-placeholders.json"
    normalized = normalize_plan(json.loads(fixture.read_text()))

    for item in normalized["workItems"]:
        assert item["notes"] in {"null", "none"}
        for field in _NULLABLE_WORK_FIELDS:
            assert item[field] is None
    INTAKE_STRUCTURE(normalized)


def test_work_refinement_schema_accepts_typed_edits_and_clarifications():
    proposal = {
        "intent": "improve",
        "summary": "Die nächste Handlung ist noch unklar.",
        "disposition": "clarification",
        "question": "Geht es noch um die Auswahl oder nur um die Montage?",
        "changes": [],
    }
    assert WORK_REFINEMENT_STRUCTURE(proposal) == proposal

    change = {
        "kind": "update_task",
        "targetId": 12,
        "title": "Kita-Formular im Sekretariat abgeben",
        "rationale": "Macht die Handlung konkret.",
    }
    proposal.update({"disposition": "changes", "question": None, "changes": [change]})
    assert WORK_REFINEMENT_STRUCTURE(proposal)["changes"] == [change]


def test_work_refinement_generation_schema_survives_ha_structured_output_adjustment():
    converted = to_openapi(_probatio_schema_from_voluptuous(WORK_REFINEMENT_STRUCTURE))
    _ha_2026_9_3_adjust_schema(converted)

    assert converted["properties"]["intent"]["type"] == "string"
    assert converted["properties"]["disposition"]["type"] == "string"
    change = converted["properties"]["changes"]["items"]
    assert change["additionalProperties"] is False
    assert change["properties"]["kind"]["type"] == "string"
    assert change["properties"]["kind"]["enum"] == [
        "update_task", "update_project", "convert_task_to_project", "create_child",
        "move_task", "add_dependency", "update_wait", "update_project_outcome", "advisory",
    ]

    provider_shape = {
        "intent": "improve",
        "summary": "Klarer benennen",
        "disposition": "changes",
        "question": None,
        "changes": [{
            "kind": "update_task",
            "rationale": "Der nächste Schritt wird klar.",
            "accepted": None,
            "targetId": 12,
            "title": "Formular abgeben",
            "notes": None,
            "projectId": None,
            "waitingFor": None,
        }],
    }
    assert WORK_REFINEMENT_STRUCTURE(provider_shape)["changes"][0]["accepted"] is None


@pytest.mark.parametrize("disposition", ["clarification", "leave_alone"])
def test_work_refinement_schema_accepts_no_change_dispositions(disposition):
    proposal = {
        "intent": "improve", "summary": "Die Aufgabe ist klar genug.",
        "disposition": disposition,
        "question": "Welche Haustür ist gemeint?" if disposition == "clarification" else None,
        "changes": [],
    }
    assert WORK_REFINEMENT_STRUCTURE(proposal) == proposal


def test_work_refinement_schema_rejects_unknown_change_kind():
    proposal = {
        "intent": "structure", "summary": "Review", "disposition": "changes",
        "question": None, "changes": [{"kind": "rewrite_everything", "rationale": "bad"}],
    }
    with pytest.raises(vol.Invalid):
        WORK_REFINEMENT_STRUCTURE(proposal)
    with pytest.raises(vol.Invalid):
        WORK_REFINEMENT_STRUCTURE({"intent": "improve"})


async def test_async_analyze_routes_refinement_and_regular_modes(hass):
    from homeassistant.components import ai_task

    hass.data[ai_task.DATA_COMPONENT] = SimpleNamespace(get_entity=lambda _entity_id: None)
    refinement = {
        "intent": "improve", "summary": "Klarer benennen", "disposition": "changes",
        "question": None,
        "changes": [{"kind": "update_task", "targetId": 12, "title": "Kita-Formular abgeben",
                     "notes": None, "projectId": None,
                     "rationale": "Der nächste Schritt wird klar."}],
    }
    regular = json.loads((Path(__file__).resolve().parents[1] / "packages/shared/fixtures/intake-plan/valid-all-day.json").read_text())
    generated = AsyncMock(side_effect=[SimpleNamespace(data=refinement), SimpleNamespace(data=regular)])
    with patch("custom_components.machbar.intake.ai_task_capabilities", return_value={"state": "ok", "supportsAttachments": False}), \
         patch("homeassistant.components.ai_task.task.async_generate_data", generated):
        result = await async_analyze(hass, None, "ai_task.test", {"taskName": "Machbar", "instructions": "Review", "analysisMode": "work_refinement"})
        assert result["changes"][0]["accepted"] is False
        assert "projectId" not in result["changes"][0]
        assert generated.await_args_list[0].kwargs["structure"] is WORK_REFINEMENT_STRUCTURE
        normal = await async_analyze(hass, None, "ai_task.test", {"taskName": "Machbar", "instructions": "Review"})
        assert normal["summary"] == regular["summary"]
        assert generated.await_args_list[1].kwargs["structure"] is INTAKE_STRUCTURE


async def test_async_analyze_rejects_unknown_refinement_kind(hass):
    from homeassistant.components import ai_task

    hass.data[ai_task.DATA_COMPONENT] = SimpleNamespace(get_entity=lambda _entity_id: None)
    malformed = {"intent": "improve", "summary": "Invalid", "disposition": "changes", "question": None,
                 "changes": [{"kind": "unknown", "rationale": "not supported"}]}
    with patch("custom_components.machbar.intake.ai_task_capabilities", return_value={"state": "ok", "supportsAttachments": False}), \
         patch("homeassistant.components.ai_task.task.async_generate_data", AsyncMock(return_value=SimpleNamespace(data=malformed))):
        with pytest.raises(AdapterError) as err:
            await async_analyze(hass, None, "ai_task.test", {"taskName": "Machbar", "instructions": "Review", "analysisMode": "work_refinement"})
    assert err.value.code == "ai_task_invalid_response"
    assert err.value.path == ["changes", 0, "kind"]
