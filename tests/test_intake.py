"""Tests for the AI Task adapter."""

from custom_components.machbar.intake import normalize_plan


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
