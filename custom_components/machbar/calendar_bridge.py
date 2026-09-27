"""Calendar adapter for Machbar."""

from __future__ import annotations

import asyncio
import re
from datetime import date, datetime, timedelta
from typing import Any

from .const import CORRELATION_PREFIX
from .intake import AdapterError


def calendar_capabilities(hass: Any, entity_id: str | None) -> dict[str, Any]:
    from homeassistant.components import calendar
    from homeassistant.components.calendar import CalendarEntityFeature

    if not entity_id:
        return {"entityId": None, "state": "not_configured"}
    entity = hass.data.get(calendar.DATA_COMPONENT, {}).get_entity(entity_id)
    if entity is None:
        return {"entityId": entity_id, "state": "missing"}
    if not entity.supported_features & CalendarEntityFeature.CREATE_EVENT:
        return {"entityId": entity_id, "state": "not_writable"}
    return {"entityId": entity_id, "state": "ok"}


async def async_create_event(hass: Any, entity_id: str | None, payload: dict[str, Any]) -> dict[str, Any]:
    from homeassistant.components import calendar
    from homeassistant.util import dt as dt_util

    capabilities = calendar_capabilities(hass, entity_id)
    if capabilities["state"] == "not_configured" or capabilities["state"] == "missing":
        raise AdapterError("calendar_not_configured")
    if capabilities["state"] != "ok":
        raise AdapterError("calendar_not_writable")
    entity = hass.data[calendar.DATA_COMPONENT].get_entity(entity_id)
    marker = f"{CORRELATION_PREFIX}{payload['correlationId']}"
    description = payload.get("description")
    description = (description.strip() + "\n\n" if description and description.strip() else "") + marker
    if payload["allDay"]:
        start = date.fromisoformat(payload["startDate"])
        end = date.fromisoformat(payload["endDate"]) + timedelta(days=1)
        query_start = datetime.combine(start, datetime.min.time(), dt_util.get_time_zone(hass.config.time_zone)) - timedelta(days=1)
        query_end = datetime.combine(end, datetime.min.time(), dt_util.get_time_zone(hass.config.time_zone)) + timedelta(days=1)
        dtstart, dtend = start, end
    else:
        dtstart = dt_util.parse_datetime(payload["startDateTime"])
        dtend = dt_util.parse_datetime(payload["endDateTime"]) if payload.get("endDateTime") else None
        if dtstart is None or dtstart.tzinfo is None or dtend is None or dtend.tzinfo is None:
            raise AdapterError("calendar_create_failed")
        query_start, query_end = dtstart - timedelta(days=1), dtend + timedelta(days=1)

    async def find() -> Any:
        events = await entity.async_get_events(hass, query_start, query_end)
        pattern = re.compile(rf"(?m)^{re.escape(marker)}\s*$")
        return next((event for event in events if pattern.search(event.description or "")), None)

    event = await find()
    if event is None:
        kwargs = {"summary": payload["title"], "dtstart": dtstart, "dtend": dtend, "description": description}
        if payload.get("location") is not None:
            kwargs["location"] = payload["location"]
        try:
            await entity.async_create_event(**kwargs)
        except Exception as err:
            raise AdapterError("calendar_create_failed") from err
        for delay in (1, 2, 4):
            await asyncio.sleep(delay)
            event = await find()
            if event is not None:
                break
    if event is None or not event.uid:
        raise AdapterError("calendar_uid_not_recovered")
    return {
        "calendarEntityId": entity_id,
        "uid": event.uid,
        "recurrenceId": event.recurrence_id,
        "summary": payload["title"],
        "start": event.start.isoformat(),
        "end": event.end.isoformat(),
        "correlationId": payload["correlationId"],
    }
