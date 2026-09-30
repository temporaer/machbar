"""Tests for calendar idempotency marker handling."""

from unittest.mock import AsyncMock, MagicMock, patch

from custom_components.machbar.calendar_bridge import async_create_event


async def test_calendar_reuses_marker(hass):
    event = MagicMock(uid="uid-1", recurrence_id=None, summary="Meeting")
    event.description = "machbar-ref:c1"
    event.start = MagicMock(isoformat=lambda: "2026-01-01T10:00:00+00:00")
    event.end = MagicMock(isoformat=lambda: "2026-01-01T11:00:00+00:00")
    entity = MagicMock(supported_features=1)
    entity.async_get_events = AsyncMock(return_value=[event])
    hass.data.setdefault("calendar", MagicMock()).get_entity = MagicMock(return_value=entity)
    with patch("homeassistant.components.calendar.DATA_COMPONENT", "calendar"):
        result = await async_create_event(
            hass,
            "calendar.test",
            {
                "correlationId": "c1",
                "title": "Meeting",
                "description": None,
                "location": None,
                "allDay": False,
                "startDateTime": "2026-01-01T10:00:00+00:00",
                "endDateTime": "2026-01-01T11:00:00+00:00",
            },
        )
    assert result["uid"] == "uid-1"
    entity.async_create_event.assert_not_called()
