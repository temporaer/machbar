"""Tests for the AI Task adapter."""

import json
from pathlib import Path

import pytest
import voluptuous as vol

from custom_components.machbar.intake import INTAKE_STRUCTURE, AdapterError, normalize_plan


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
