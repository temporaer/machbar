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
_MISSING = object()
_PROJECT_TASK_FIELDS = ("notBeforeDate", "notBeforeAt", "reminders", "needsClarification")


def _field(key: str, schema: Any) -> Any:
    return vol.Required(key, description=f"Machbar intake field {key}")


def _optional_field(key: str, default: Any, schema: Any) -> Any:
    return vol.Optional(key, default=default, description=f"Machbar intake field {key}")


def _calendar_schema() -> vol.Schema:
    return vol.Schema(
        {
            _field("key", str): str,
            _field("title", str): str,
            _optional_field("description", None, _NULL): _NULL,
            _optional_field("location", None, _NULL): _NULL,
            _field("allDay", bool): bool,
            _optional_field("startDate", None, _NULL): _NULL,
            _optional_field("endDate", None, _NULL): _NULL,
            _optional_field("startDateTime", None, _NULL): _NULL,
            _optional_field("endDateTime", None, _NULL): _NULL,
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
            _optional_field("notes", None, _NULL): _NULL,
            _optional_field("parentKey", None, _NULL): _NULL,
            _optional_field("ownerName", None, _NULL): _NULL,
            _optional_field("dueDate", None, _NULL): _NULL,
            _optional_field("scheduledDate", None, _NULL): _NULL,
            _optional_field("revisitAt", None, _NULL): _NULL,
            _optional_field("notBeforeDate", None, _NULL): _NULL,
            _optional_field("notBeforeAt", None, _NULL): _NULL,
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
            _optional_field("at", None, _NULL): _NULL,
            _optional_field("daysBefore", None, vol.Any(None, int)): vol.Any(None, int),
            _optional_field("time", None, _NULL): _NULL,
            _optional_field("timezone", None, _NULL): _NULL,
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
        actual_type: str | None = None,
        value_preview: str | None = None,
    ) -> None:
        self.code = code
        self.path = path
        self.expected_type = expected_type
        self.actual_type = actual_type
        self.value_preview = value_preview
        super().__init__(message or code)

    @property
    def details(self) -> dict[str, Any]:
        return {
            key: value
            for key, value in (
                ("path", self.path),
                ("expectedType", self.expected_type),
                ("actualType", self.actual_type),
                ("valuePreview", self.value_preview),
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


_SAFE_PREVIEW_FIELDS = {
    "key",
    "parentKey",
    "relatedWorkKeys",
    "relatedCalendarKeys",
    "dueDate",
    "scheduledDate",
    "revisitAt",
    "notBeforeDate",
    "notBeforeAt",
    "startDate",
    "endDate",
    "startDateTime",
    "endDateTime",
    "at",
}


def _actual_type(value: Any) -> str:
    if value is _MISSING:
        return "missing"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _value_preview(path: list[str | int], value: Any) -> str | None:
    if not any(isinstance(part, str) and part in _SAFE_PREVIEW_FIELDS for part in path):
        return None
    if not isinstance(value, str):
        return None
    bounded = value[:80].replace("\r", " ").replace("\n", " ").replace("\t", " ")
    return f'"{bounded}{"..." if len(value) > 80 else ""}"'


def _invalid(
    path: list[str | int],
    expected: str,
    message: str | None = None,
    value: Any = _MISSING,
) -> AdapterError:
    actual = _actual_type(value)
    preview = _value_preview(path, value)
    detail = message or f"Invalid AI Task response at {_path_text(path)}; expected {expected}."
    return AdapterError(
        "ai_task_invalid_response",
        detail,
        path=path,
        expected_type=expected,
        actual_type=actual,
        value_preview=preview,
    )


def _required(raw: dict[str, Any], key: str, path: list[str | int], expected: str) -> Any:
    if key not in raw:
        raise _invalid(path + [key], expected, value=_MISSING)
    return raw[key]


def _normalize_string(
    value: Any,
    nullable: bool = True,
    *,
    path: list[str | int],
    absence: bool = False,
) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str):
        raise _invalid(path, "a string or null" if nullable else "a string", value=value)
    stripped = value.strip()
    # Only contract fields where strings represent absence use textual nulls.
    if absence and nullable and _is_absent_string(stripped):
        return None
    return stripped


def _is_absent_string(value: str) -> bool:
    return (
        not value
        or value.lower() in {"null", "none"}
        or not re.search(r"[^\W_]", value, re.UNICODE)
    )


def _meaningful_project_field(field: str, value: Any) -> bool:
    if value is None or (isinstance(value, bool) and not value):
        return False
    if field == "reminders" and isinstance(value, list) and not value:
        return False
    if field in {"notBeforeDate", "notBeforeAt"} and isinstance(value, str):
        return not _is_absent_string(value.strip())
    return True


def _compact_plan(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    calendar_fields = {
        "key", "title", "description", "location", "allDay", "startDate",
        "endDate", "startDateTime", "endDateTime", "relatedWorkKeys",
    }
    work_fields = {
        "key", "kind", "title", "notes", "parentKey", "ownerName", "dueDate",
        "scheduledDate", "notBeforeDate", "notBeforeAt", "reminders",
        "needsClarification", "relatedCalendarKeys",
    }
    warning_fields = {"message"}

    def strip(raw: dict[str, Any], allowed: set[str]) -> dict[str, Any]:
        return {key: item for key, item in raw.items() if key in allowed}

    project_warnings: list[dict[str, str]] = []
    calendars = value.get("calendarEvents", [])
    if calendars is None:
        calendars = []
    if isinstance(calendars, list):
        normalized_calendars = []
        for raw in calendars:
            if not isinstance(raw, dict):
                normalized_calendars.append(raw)
                continue
            item = {
                "description": None,
                "location": None,
                "allDay": False,
                "startDate": None,
                "endDate": None,
                "startDateTime": None,
                "endDateTime": None,
                "relatedWorkKeys": [],
                **strip(raw, calendar_fields),
            }
            for field, default in (("allDay", False), ("relatedWorkKeys", [])):
                if item[field] is None:
                    item[field] = default
            normalized_calendars.append(item)
        calendars = normalized_calendars
    work = value.get("workItems", [])
    if work is None:
        work = []
    if isinstance(work, list):
        normalized_work = []
        for index, raw in enumerate(work):
            if not isinstance(raw, dict):
                normalized_work.append(raw)
                continue
            item = strip(raw, work_fields)
            meaningful_project_fields = (
                raw.get("kind") == "project"
                and any(
                    field in item and _meaningful_project_field(field, item[field])
                    for field in _PROJECT_TASK_FIELDS
                )
            )
            if meaningful_project_fields:
                project_key = item.get("key")
                label = project_key if isinstance(project_key, str) and project_key else str(index)
                project_warnings.append({
                    "message": f"Ignored task-only fields on project '{label}'.",
                })
            if raw.get("kind") == "project":
                for field in _PROJECT_TASK_FIELDS:
                    item.pop(field, None)
            compacted_item = {
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
                **item,
            }
            for field, default in (
                ("reminders", []),
                ("needsClarification", False),
                ("relatedCalendarKeys", []),
            ):
                if compacted_item[field] is None:
                    compacted_item[field] = default
            normalized_work.append(compacted_item)
        work = normalized_work
    warnings = value.get("warnings", [])
    if warnings is None:
        warnings = []
    if isinstance(warnings, list):
        warnings = [
            strip(item, warning_fields) if isinstance(item, dict) else item
            for item in warnings
        ]
        warnings.extend(project_warnings)
    compacted: dict[str, Any] = {}
    if "summary" in value:
        compacted["summary"] = value["summary"]
    compacted["calendarEvents"] = calendars
    compacted["workItems"] = work
    compacted["warnings"] = warnings
    return compacted


def _normalize_strings(value: Any, *, path: list[str | int]) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise _invalid(path, "an array of strings", value=value)
    return [item.strip() for item in value]


def _normalize_reminders(value: Any, *, path: list[str | int]) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise _invalid(path, "an array of reminder objects", value=value)
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(value):
        item_path = path + [index]
        if not isinstance(raw, dict):
            raise _invalid(item_path, "an object", value=raw)
        kind = _required(raw, "kind", item_path, '"absolute" or "deadline_relative"')
        if kind not in ("absolute", "deadline_relative"):
            raise _invalid(item_path + ["kind"], '"absolute" or "deadline_relative"', value=kind)
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
                raise _invalid(item_path + ["daysBefore"], "a non-negative integer", value=days_before)
            if not isinstance(time, str) or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", time):
                raise _invalid(item_path + ["time"], "an HH:mm string", value=time)
            if not isinstance(timezone, str) or not timezone.strip():
                raise _invalid(item_path + ["timezone"], "an IANA timezone string", value=timezone)
            normalized.append({
                "kind": kind,
                "daysBefore": days_before,
                "time": time,
                "timezone": timezone.strip(),
            })
    return normalized


def normalize_plan(data: Any) -> dict[str, Any]:
    data = _compact_plan(data)
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
                raise _invalid(item_path, "an object", value=raw)
            all_day = _required(raw, "allDay", item_path, "a boolean")
            if not isinstance(all_day, bool):
                raise _invalid(item_path + ["allDay"], "a boolean", value=all_day)
            start_date = _normalize_string(_required(raw, "startDate", item_path, "a date or null"), path=item_path + ["startDate"], absence=True)
            end_date = _normalize_string(_required(raw, "endDate", item_path, "a date or null"), path=item_path + ["endDate"], absence=True)
            start_datetime = _normalize_string(_required(raw, "startDateTime", item_path, "an RFC 3339 instant or null"), path=item_path + ["startDateTime"], absence=True)
            end_datetime = _normalize_string(_required(raw, "endDateTime", item_path, "an RFC 3339 instant or null"), path=item_path + ["endDateTime"], absence=True)
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
                raise _invalid(item_path, "an object", value=raw)
            if "reminderAt" in raw:
                raise _invalid(item_path + ["reminderAt"], "the reminders array", "Legacy reminderAt is not supported; return reminders instead.")
            kind = _required(raw, "kind", item_path, '"action", "project", or "reference"')
            if kind not in ("action", "project", "reference"):
                raise _invalid(item_path + ["kind"], '"action", "project", or "reference"', value=kind)
            clarification = _required(raw, "needsClarification", item_path, "a boolean")
            if not isinstance(clarification, bool):
                raise _invalid(item_path + ["needsClarification"], "a boolean", value=clarification)
            work.append(
                {
                    "key": _normalize_string(_required(raw, "key", item_path, "a string"), False, path=item_path + ["key"]),
                    "kind": kind,
                    "title": _normalize_string(_required(raw, "title", item_path, "a string"), False, path=item_path + ["title"]),
                    "notes": _normalize_string(_required(raw, "notes", item_path, "a string or null"), path=item_path + ["notes"]),
                    "parentKey": _normalize_string(_required(raw, "parentKey", item_path, "a string or null"), path=item_path + ["parentKey"], absence=True),
                    "ownerName": _normalize_string(_required(raw, "ownerName", item_path, "a string or null"), path=item_path + ["ownerName"], absence=True),
                    "dueDate": _normalize_string(_required(raw, "dueDate", item_path, "a date or null"), path=item_path + ["dueDate"], absence=True),
                    "scheduledDate": _normalize_string(_required(raw, "scheduledDate", item_path, "a date or null"), path=item_path + ["scheduledDate"], absence=True),
                    "revisitAt": _normalize_string(raw.get("revisitAt"), path=item_path + ["revisitAt"], absence=True),
                    "notBeforeDate": _normalize_string(_required(raw, "notBeforeDate", item_path, "a date or null"), path=item_path + ["notBeforeDate"], absence=True),
                    "notBeforeAt": _normalize_string(_required(raw, "notBeforeAt", item_path, "an RFC 3339 instant or null"), path=item_path + ["notBeforeAt"], absence=True),
                    "reminders": _normalize_reminders(_required(raw, "reminders", item_path, "an array of reminder objects"), path=item_path + ["reminders"]),
                    "needsClarification": clarification,
                    "relatedCalendarKeys": _normalize_strings(_required(raw, "relatedCalendarKeys", item_path, "an array of strings"), path=item_path + ["relatedCalendarKeys"]),
                }
            )
        warnings = []
        for index, raw in enumerate(warning_values):
            item_path = ["warnings", index]
            if not isinstance(raw, dict):
                raise _invalid(item_path, "an object", value=raw)
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
