"""Tests for the AI Task adapter."""

import pytest
import voluptuous as vol

from custom_components.machbar.intake import INTAKE_STRUCTURE, normalize_plan


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
                "reminderAt": None,
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
