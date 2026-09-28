"""Home Assistant AI Task adapter for Machbar intake."""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from pathlib import Path
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
            _field("reminderAt", _NULL): _NULL,
            _field("needsClarification", bool): bool,
            _field("relatedCalendarKeys", [str]): [str],
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

    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        super().__init__(message or code)


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


def _normalize_string(value: Any, nullable: bool = True) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str):
        raise AdapterError("ai_task_invalid_response")
    return value.strip()


def _normalize_strings(value: Any) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise AdapterError("ai_task_invalid_response")
    return [item.strip() for item in value]


def normalize_plan(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise AdapterError("ai_task_invalid_response")
    try:
        calendars = []
        for raw in data.get("calendarEvents", []):
            if not isinstance(raw, dict):
                raise AdapterError("ai_task_invalid_response")
            calendars.append(
                {
                    "key": _normalize_string(raw.get("key"), False),
                    "title": _normalize_string(raw.get("title"), False),
                    "description": _normalize_string(raw.get("description")),
                    "location": _normalize_string(raw.get("location")),
                    "allDay": raw.get("allDay", False) if isinstance(raw.get("allDay", False), bool) else (_ for _ in ()).throw(AdapterError("ai_task_invalid_response")),
                    "startDate": _normalize_string(raw.get("startDate")),
                    "endDate": _normalize_string(raw.get("endDate")),
                    "startDateTime": _normalize_string(raw.get("startDateTime")),
                    "endDateTime": _normalize_string(raw.get("endDateTime")),
                    "relatedWorkKeys": _normalize_strings(raw.get("relatedWorkKeys", [])),
                }
            )
        work = []
        for raw in data.get("workItems", []):
            if not isinstance(raw, dict):
                raise AdapterError("ai_task_invalid_response")
            if raw.get("kind", "action") not in ("action", "project", "reference"):
                raise AdapterError("ai_task_invalid_response")
            work.append(
                {
                    "key": _normalize_string(raw.get("key"), False),
                    "kind": raw.get("kind", "action"),
                    "title": _normalize_string(raw.get("title"), False),
                    "notes": _normalize_string(raw.get("notes")),
                    "parentKey": _normalize_string(raw.get("parentKey")),
                    "ownerName": _normalize_string(raw.get("ownerName")),
                    "dueDate": _normalize_string(raw.get("dueDate")),
                    "scheduledDate": _normalize_string(raw.get("scheduledDate")),
                    "notBeforeDate": _normalize_string(raw.get("notBeforeDate")),
                    "notBeforeAt": _normalize_string(raw.get("notBeforeAt")),
                    "reminderAt": _normalize_string(raw.get("reminderAt")),
                    "needsClarification": raw.get("needsClarification", False) if isinstance(raw.get("needsClarification", False), bool) else (_ for _ in ()).throw(AdapterError("ai_task_invalid_response")),
                    "relatedCalendarKeys": _normalize_strings(raw.get("relatedCalendarKeys", [])),
                }
            )
        warnings = []
        for raw in data.get("warnings", []):
            if not isinstance(raw, dict):
                raise AdapterError("ai_task_invalid_response")
            warnings.append({"message": _normalize_string(raw.get("message"), False)})
        result = {
            "summary": _normalize_string(data.get("summary", ""), False),
            "calendarEvents": calendars,
            "workItems": work,
            "warnings": warnings,
        }
        if any(not isinstance(x, str) for item in calendars + work for x in item.get("relatedWorkKeys", item.get("relatedCalendarKeys", []))):
            raise AdapterError("ai_task_invalid_response")
        return result
    except (TypeError, KeyError):
        raise AdapterError("ai_task_invalid_response")


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
        instructions += f"\n\nSOURCE TEXT:\n<<<\n{text}\n>>>"
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
