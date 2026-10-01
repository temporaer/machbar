"""Home Assistant AI Task adapter for Machbar intake."""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from pathlib import Path
import re
from typing import Any

import voluptuous as vol

from .const import MAX_ATTACHMENT_BYTES

_LOGGER = logging.getLogger(__name__)
_NULL = vol.Any(None, str)


def _field(key: str, schema: Any) -> Any:
    return vol.Required(key, description=f"Machbar intake field {key}")


def _calendar_schema() -> vol.Schema:
    return vol.Schema(
        {
            _field("key", str): str,
            _field("title", str): str,
            _field("description", _NULL): _NULL,
            _field("location", _NULL): _NULL,
            _field("allDay", bool): bool,
            _field("startDate", _NULL): _NULL,
            _field("endDate", _NULL): _NULL,
            _field("startDateTime", _NULL): _NULL,
            _field("endDateTime", _NULL): _NULL,
            _field("relatedWorkKeys", [str]): [str],
        },
        extra=vol.PREVENT_EXTRA,
    )


def _work_schema() -> vol.Schema:
    return vol.Schema(
        {
            _field("key", str): str,
            _field("kind", vol.In(["action", "project", "reference"])): vol.In(
                ["action", "project", "reference"]
            ),
            _field("title", str): str,
            _field("notes", _NULL): _NULL,
            _field("parentKey", _NULL): _NULL,
            _field("ownerName", _NULL): _NULL,
            _field("dueDate", _NULL): _NULL,
            _field("scheduledDate", _NULL): _NULL,
            _field("notBeforeDate", _NULL): _NULL,
            _field("notBeforeAt", _NULL): _NULL,
            _field("reminders", [_reminder_schema()]): [_reminder_schema()],
            _field("needsClarification", bool): bool,
            _field("relatedCalendarKeys", [str]): [str],
        },
        extra=vol.PREVENT_EXTRA,
    )


def _reminder_schema() -> vol.Schema:
    return vol.Schema(
        {
            _field("kind", vol.In(["absolute", "deadline_relative"])): vol.In(
                ["absolute", "deadline_relative"]
            ),
            _field("at", _NULL): _NULL,
            _field("daysBefore", vol.Any(None, int)): vol.Any(None, int),
            _field("time", _NULL): _NULL,
            _field("timezone", _NULL): _NULL,
        },
        extra=vol.PREVENT_EXTRA,
    )


def _warning_schema() -> vol.Schema:
    return vol.Schema(
        {_field("message", str): str},
        extra=vol.PREVENT_EXTRA,
    )


INTAKE_STRUCTURE = vol.Schema(
    {
        _field("summary", str): str,
        _field("calendarEvents", [_calendar_schema()]): [_calendar_schema()],
        _field("workItems", [_work_schema()]): [_work_schema()],
        _field("warnings", [_warning_schema()]): [_warning_schema()],
    },
    extra=vol.PREVENT_EXTRA,
)


class AdapterError(Exception):
    """An AI Task or calendar adapter error."""

    def __init__(
        self,
        code: str,
        message: str | None = None,
        *,
        path: list[str | int] | None = None,
        expected_type: str | None = None,
    ) -> None:
        self.code = code
        self.path = path
        self.expected_type = expected_type
        super().__init__(message or code)

    @property
    def details(self) -> dict[str, Any]:
        return {
            key: value
            for key, value in (
                ("path", self.path),
                ("expectedType", self.expected_type),
            )
            if value is not None
        }


def ai_task_capabilities(hass: Any, entity_id: str | None) -> dict[str, Any]:
    try:
        from homeassistant.components import ai_task
        from homeassistant.components.ai_task.const import AITaskEntityFeature
    except ImportError:
        return {"entityId": entity_id, "state": "missing" if entity_id else "not_configured", "supportsAttachments": False}

    if not entity_id:
        return {"entityId": None, "state": "not_configured", "supportsAttachments": False}
    entity = hass.data.get(ai_task.DATA_COMPONENT, {}).get_entity(entity_id)
    if entity is None:
        return {"entityId": entity_id, "state": "missing", "supportsAttachments": False}
    features = entity.supported_features
    return {
        "entityId": entity_id,
        "state": "ok" if features & AITaskEntityFeature.GENERATE_DATA else "no_generate_data",
        "supportsAttachments": bool(features & AITaskEntityFeature.SUPPORT_ATTACHMENTS),
    }


def _path_text(path: list[str | int]) -> str:
    return "".join(
        f"[{part}]" if isinstance(part, int) else (part if index == 0 else f".{part}")
        for index, part in enumerate(path)
    )


def _invalid(path: list[str | int], expected: str, message: str | None = None) -> AdapterError:
    return AdapterError(
        "ai_task_invalid_response",
        message or f"Invalid AI Task response at {_path_text(path)}; expected {expected}.",
        path=path,
        expected_type=expected,
    )


def _required(raw: dict[str, Any], key: str, path: list[str | int], expected: str) -> Any:
    if key not in raw:
        raise _invalid(path + [key], expected)
    return raw[key]


def _normalize_string(
    value: Any,
    nullable: bool = True,
    *,
    path: list[str | int],
) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str):
        raise _invalid(path, "a string or null" if nullable else "a string")
    stripped = value.strip()
    # Models often emit "" for absent nullable fields; Machbar expects null.
    if not stripped and nullable:
        return None
    return stripped


def _normalize_strings(value: Any, *, path: list[str | int]) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise _invalid(path, "an array of strings")
    return [item.strip() for item in value]


def _normalize_reminders(value: Any, *, path: list[str | int]) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise _invalid(path, "an array of reminder objects")
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(value):
        item_path = path + [index]
        if not isinstance(raw, dict):
            raise _invalid(item_path, "an object")
        kind = _required(raw, "kind", item_path, '"absolute" or "deadline_relative"')
        if kind not in ("absolute", "deadline_relative"):
            raise _invalid(item_path + ["kind"], '"absolute" or "deadline_relative"')
        if kind == "absolute":
            at = _normalize_string(
                _required(raw, "at", item_path, "an RFC 3339 instant"),
                False,
                path=item_path + ["at"],
            )
            normalized.append({"kind": kind, "at": at})
        else:
            days_before = _required(raw, "daysBefore", item_path, "a non-negative integer")
            time = _required(raw, "time", item_path, "an HH:mm string")
            timezone = _required(raw, "timezone", item_path, "an IANA timezone string")
            if isinstance(days_before, bool) or not isinstance(days_before, int) or days_before < 0:
                raise _invalid(item_path + ["daysBefore"], "a non-negative integer")
            if not isinstance(time, str) or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", time):
                raise _invalid(item_path + ["time"], "an HH:mm string")
            if not isinstance(timezone, str) or not timezone.strip():
                raise _invalid(item_path + ["timezone"], "an IANA timezone string")
            normalized.append({
                "kind": kind,
                "daysBefore": days_before,
                "time": time,
                "timezone": timezone.strip(),
            })
    return normalized


def normalize_plan(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise _invalid([], "an object")
    try:
        calendar_values = _required(data, "calendarEvents", [], "an array")
        work_values = _required(data, "workItems", [], "an array")
        warning_values = _required(data, "warnings", [], "an array")
        if not isinstance(calendar_values, list):
            raise _invalid(["calendarEvents"], "an array")
        if not isinstance(work_values, list):
            raise _invalid(["workItems"], "an array")
        if not isinstance(warning_values, list):
            raise _invalid(["warnings"], "an array")
        calendars = []
        for index, raw in enumerate(calendar_values):
            item_path = ["calendarEvents", index]
            if not isinstance(raw, dict):
                raise _invalid(item_path, "an object")
            all_day = _required(raw, "allDay", item_path, "a boolean")
            if not isinstance(all_day, bool):
                raise _invalid(item_path + ["allDay"], "a boolean")
            start_date = _normalize_string(_required(raw, "startDate", item_path, "a date or null"), path=item_path + ["startDate"])
            end_date = _normalize_string(_required(raw, "endDate", item_path, "a date or null"), path=item_path + ["endDate"])
            start_datetime = _normalize_string(_required(raw, "startDateTime", item_path, "an RFC 3339 instant or null"), path=item_path + ["startDateTime"])
            end_datetime = _normalize_string(_required(raw, "endDateTime", item_path, "an RFC 3339 instant or null"), path=item_path + ["endDateTime"])
            if all_day:
                start_datetime = None
                end_datetime = None
            else:
                start_date = None
                end_date = None
            calendars.append(
                {
                    "key": _normalize_string(_required(raw, "key", item_path, "a string"), False, path=item_path + ["key"]),
                    "title": _normalize_string(_required(raw, "title", item_path, "a string"), False, path=item_path + ["title"]),
                    "description": _normalize_string(_required(raw, "description", item_path, "a string or null"), path=item_path + ["description"]),
                    "location": _normalize_string(_required(raw, "location", item_path, "a string or null"), path=item_path + ["location"]),
                    "allDay": all_day,
                    "startDate": start_date,
                    "endDate": end_date,
                    "startDateTime": start_datetime,
                    "endDateTime": end_datetime,
                    "relatedWorkKeys": _normalize_strings(_required(raw, "relatedWorkKeys", item_path, "an array of strings"), path=item_path + ["relatedWorkKeys"]),
                }
            )
        work = []
        for index, raw in enumerate(work_values):
            item_path = ["workItems", index]
            if not isinstance(raw, dict):
                raise _invalid(item_path, "an object")
            if "reminderAt" in raw:
                raise _invalid(item_path + ["reminderAt"], "the reminders array", "Legacy reminderAt is not supported; return reminders instead.")
            kind = _required(raw, "kind", item_path, '"action", "project", or "reference"')
            if kind not in ("action", "project", "reference"):
                raise _invalid(item_path + ["kind"], '"action", "project", or "reference"')
            clarification = _required(raw, "needsClarification", item_path, "a boolean")
            if not isinstance(clarification, bool):
                raise _invalid(item_path + ["needsClarification"], "a boolean")
            work.append(
                {
                    "key": _normalize_string(_required(raw, "key", item_path, "a string"), False, path=item_path + ["key"]),
                    "kind": kind,
                    "title": _normalize_string(_required(raw, "title", item_path, "a string"), False, path=item_path + ["title"]),
                    "notes": _normalize_string(_required(raw, "notes", item_path, "a string or null"), path=item_path + ["notes"]),
                    "parentKey": _normalize_string(_required(raw, "parentKey", item_path, "a string or null"), path=item_path + ["parentKey"]),
                    "ownerName": _normalize_string(_required(raw, "ownerName", item_path, "a string or null"), path=item_path + ["ownerName"]),
                    "dueDate": _normalize_string(_required(raw, "dueDate", item_path, "a date or null"), path=item_path + ["dueDate"]),
                    "scheduledDate": _normalize_string(_required(raw, "scheduledDate", item_path, "a date or null"), path=item_path + ["scheduledDate"]),
                    "notBeforeDate": _normalize_string(_required(raw, "notBeforeDate", item_path, "a date or null"), path=item_path + ["notBeforeDate"]),
                    "notBeforeAt": _normalize_string(_required(raw, "notBeforeAt", item_path, "an RFC 3339 instant or null"), path=item_path + ["notBeforeAt"]),
                    "reminders": _normalize_reminders(_required(raw, "reminders", item_path, "an array of reminder objects"), path=item_path + ["reminders"]),
                    "needsClarification": clarification,
                    "relatedCalendarKeys": _normalize_strings(_required(raw, "relatedCalendarKeys", item_path, "an array of strings"), path=item_path + ["relatedCalendarKeys"]),
                }
            )
        warnings = []
        for index, raw in enumerate(warning_values):
            item_path = ["warnings", index]
            if not isinstance(raw, dict):
                raise _invalid(item_path, "an object")
            warnings.append({"message": _normalize_string(_required(raw, "message", item_path, "a string"), False, path=item_path + ["message"])})
        result = {
            "summary": _normalize_string(_required(data, "summary", [], "a string"), False, path=["summary"]),
            "calendarEvents": calendars,
            "workItems": work,
            "warnings": warnings,
        }
        return result
    except (TypeError, KeyError) as err:
        raise _invalid([], "the IntakePlan structure") from err


async def async_analyze(hass: Any, client: Any, entity_id: str | None, payload: dict[str, Any]) -> dict[str, Any]:
    from homeassistant.components import ai_task
    from homeassistant.components.ai_task.const import AITaskEntityFeature

    capabilities = ai_task_capabilities(hass, entity_id)
    if capabilities["state"] != "ok":
        raise AdapterError("ai_task_not_configured")
    attachments = payload.get("attachments", [])
    if attachments and not capabilities["supportsAttachments"]:
        raise AdapterError("ai_task_attachments_unsupported")
    instructions = payload.get("instructions", "")
    text = payload.get("text")
    if text:
        instructions += f"\n\n=== SOURCE CONTENT ===\n<<<\n{text}\n>>>"
    entity = hass.data[ai_task.DATA_COMPONENT].get_entity(entity_id)
    if not attachments:
        try:
            result = await ai_task.task.async_generate_data(
                hass, task_name=payload["taskName"], entity_id=entity_id,
                instructions=instructions, structure=INTAKE_STRUCTURE
            )
        except Exception as err:
            _LOGGER.exception("Machbar AI Task generation failed")
            raise AdapterError("ai_task_failed") from err
        return normalize_plan(result.data)

    from homeassistant.components import conversation
    from homeassistant.helpers.chat_session import async_get_chat_session
    from homeassistant.components.ai_task.task import GenDataTask

    paths: list[Path] = []
    try:
        for attachment in attachments:
            suffix = "." + attachment["mimeType"].split("/")[-1].split("+")[0]
            fd, name = await hass.async_add_executor_job(tempfile.mkstemp, suffix)
            os.close(fd)
            path = Path(name)
            paths.append(path)
            await client.download_attachment(
                payload["intakeId"], attachment["id"], path, MAX_ATTACHMENT_BYTES
            )
        ha_attachments = [
            conversation.Attachment(
                media_content_id=f"machbar://intake/{payload['intakeId']}/{item['id']}",
                mime_type=item["mimeType"], path=path,
            )
            for item, path in zip(attachments, paths)
        ]
        try:
            with async_get_chat_session(hass) as session:
                result = await entity.internal_async_generate_data(
                    session,
                    GenDataTask(
                        name=payload["taskName"], instructions=instructions,
                        structure=INTAKE_STRUCTURE, attachments=ha_attachments,
                    ),
                )
        except Exception as err:
            _LOGGER.exception("Machbar AI Task generation failed")
            raise AdapterError("ai_task_failed") from err
        return normalize_plan(result.data)
    except AdapterError:
        raise
    except Exception as err:
        raise AdapterError("intake_attachment_download_failed") from err
    finally:
        await asyncio.gather(
            *(hass.async_add_executor_job(path.unlink, True) for path in paths),
            return_exceptions=True,
        )
