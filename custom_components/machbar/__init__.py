"""Machbar Home Assistant integration."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.exceptions import (
    ConfigEntryAuthFailed,
    ConfigEntryNotReady,
    ServiceValidationError,
)
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers import config_validation as cv, selector
import voluptuous as vol
from dataclasses import dataclass

from .client import CannotConnect, InvalidAuth, MachbarClient, MachbarError
from .const import (
    CONF_ORIGIN,
    CONF_TOKEN,
    DOMAIN,
    PUSH_DELAY_SECONDS,
)
from .snapshot import build_snapshot
from .worker import RequestWorker

_LOGGER = logging.getLogger(__name__)
SERVICE_SYNC_TASK = "sync_task"


@dataclass
class MachbarRuntime:
    publisher: "SnapshotPublisher"
    worker: RequestWorker


def _sync_task_schema() -> vol.Schema:
    deadline_reminder_schema = vol.Schema(
        {
            vol.Required("days_before"): vol.All(int, vol.Range(min=0)),
            vol.Required("time"): vol.All(
                str, cv.matches_regex(r"^([01]\d|2[0-3]):[0-5]\d$")
            ),
            vol.Required("timezone"): str,
        }
    )
    deadline_reminder_item_schema = vol.Schema({
        vol.Required("key"): vol.All(str, vol.Length(min=1)),
        vol.Required("days_before"): vol.All(int, vol.Range(min=0)),
        vol.Required("time"): vol.All(
            str, cv.matches_regex(r"^([01]\d|2[0-3]):[0-5]\d$")
        ),
        vol.Required("timezone"): str,
    })

    def validate_deadline_reminders(value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            raise vol.Invalid("Deadline reminders must be a list.")
        validated = [deadline_reminder_item_schema(item) for item in value]
        keys = [item["key"] for item in validated]
        if len(keys) != len(set(keys)):
            raise vol.Invalid("Deadline reminder keys must be unique.")
        return validated

    deadline_reminders_schema = validate_deadline_reminders
    return vol.Schema(
        {
            vol.Required("config_entry_id"): str,
            vol.Required("source_key"): selector.TemplateSelector(),
            vol.Required("relevant"): bool,
            vol.Optional("title"): str,
            vol.Optional("person"): vol.Any(
                selector.EntitySelector(selector.EntitySelectorConfig(domain="person")),
                None,
            ),
            vol.Optional("scheduled_date"): vol.Any(str, None),
            vol.Optional("due_date"): vol.Any(str, None),
            vol.Optional("notes"): vol.Any(str, None),
            vol.Optional("reactivate_completed", default=False): bool,
            vol.Optional("overwrite_notes", default=False): bool,
            vol.Optional("deadline_reminder"): vol.Any(None, deadline_reminder_schema),
            vol.Optional("deadline_reminders"): vol.Any(
                None, deadline_reminders_schema
            ),
            vol.Optional("priority"): vol.Any(int, None),
            vol.Optional("size"): vol.Any(vol.In(["S", "M", "L", "XL"]), None),
        }
    )


CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, _config: dict[str, Any]) -> bool:
    """Register the action independently of config-entry availability."""
    if hass.services.has_service(DOMAIN, SERVICE_SYNC_TASK):
        return True

    async def handle_sync_task(call: Any) -> None:
        requested_entry = call.data["config_entry_id"]
        target = hass.config_entries.async_get_entry(requested_entry)
        if target is None or target.domain != DOMAIN:
            raise ServiceValidationError(
                "The selected config entry is not a Machbar integration."
            )
        if target.state is not ConfigEntryState.LOADED:
            raise ServiceValidationError(
                "The selected Machbar config entry is not loaded."
            )
        if CONF_ORIGIN not in target.data or CONF_TOKEN not in target.data:
            raise ServiceValidationError(
                "The selected Machbar config entry is not usable."
            )
        client = MachbarClient(
            async_get_clientsession(hass),
            target.data[CONF_ORIGIN],
            target.data[CONF_TOKEN],
        )
        payload = {
            "sourceKey": call.data["source_key"],
            "relevant": call.data["relevant"],
        }
        for source, target_name in (
            ("title", "title"),
            ("person", "person"),
            ("scheduled_date", "scheduledDate"),
            ("due_date", "dueDate"),
            ("notes", "notes"),
            ("reactivate_completed", "reactivateCompleted"),
            ("overwrite_notes", "overwriteNotes"),
            ("deadline_reminder", "deadlineReminder"),
            ("deadline_reminders", "deadlineReminders"),
            ("priority", "priority"),
            ("size", "size"),
        ):
            if source in call.data:
                value = call.data[source]
                if source == "deadline_reminder" and value is not None:
                    value = {
                        "daysBefore": value["days_before"],
                        "time": value["time"],
                        "timezone": value["timezone"],
                    }
                if source == "deadline_reminders" and value is not None:
                    value = [
                        {
                            "key": reminder["key"],
                            "daysBefore": reminder["days_before"],
                            "time": reminder["time"],
                            "timezone": reminder["timezone"],
                        }
                        for reminder in value
                    ]
                payload[target_name] = value
        await client.sync_task(payload)

    hass.services.async_register(
        DOMAIN,
        SERVICE_SYNC_TASK,
        handle_sync_task,
        schema=_sync_task_schema(),
    )
    return True


class SnapshotPublisher:
    """Publish complete snapshots and coalesce bursts of state events."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self._hass = hass
        self._entry = entry
        self._client = MachbarClient(
            async_get_clientsession(hass),
            entry.data[CONF_ORIGIN],
            entry.data[CONF_TOKEN],
        )
        self._cancel_listener: Any = None
        self._cancel_scheduled: Any = None
        self._push_task: asyncio.Task[None] | None = None
        self._stopped = False

    async def async_start(self) -> None:
        """Push initial state and subscribe for relevant changes."""
        await self._async_push()
        self._cancel_listener = self._hass.bus.async_listen(
            EVENT_STATE_CHANGED, self._state_changed
        )

    @callback
    def _state_changed(self, event: Event) -> None:
        entity_id = event.data.get("entity_id", "")
        configured = {
            self._entry.options.get("ai_task_entity_id"),
            self._entry.options.get("calendar_entity_id"),
        }
        if not entity_id.startswith(("person.", "zone.")) and entity_id not in configured:
            return
        if self._cancel_scheduled is not None:
            self._cancel_scheduled()
        self._cancel_scheduled = async_call_later(
            self._hass, PUSH_DELAY_SECONDS, self._scheduled_push
        )

    @callback
    def _scheduled_push(self, _now: Any) -> None:
        self._cancel_scheduled = None
        if self._stopped:
            return
        self._push_task = self._hass.async_create_task(
            self._async_push_safely(), f"{DOMAIN} snapshot push"
        )

    async def _async_push(self) -> None:
        await self._client.push_snapshot(build_snapshot(self._hass, self._entry))

    async def _async_push_safely(self) -> None:
        try:
            await self._async_push()
        except MachbarError:
            _LOGGER.warning("Unable to publish Machbar physical context", exc_info=True)
        finally:
            self._push_task = None

    async def async_stop(self) -> None:
        """Remove listeners and cancel pending work."""
        self._stopped = True
        if self._cancel_listener is not None:
            self._cancel_listener()
            self._cancel_listener = None
        if self._cancel_scheduled is not None:
            self._cancel_scheduled()
            self._cancel_scheduled = None
        if self._push_task is not None:
            self._push_task.cancel()
            await asyncio.gather(self._push_task, return_exceptions=True)
            self._push_task = None


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Machbar from a config entry."""
    publisher = SnapshotPublisher(hass, entry)
    try:
        await publisher.async_start()
    except InvalidAuth as err:
        raise ConfigEntryAuthFailed("Machbar credentials were rejected") from err
    except CannotConnect as err:
        raise ConfigEntryNotReady("Unable to connect to Machbar") from err

    worker = RequestWorker(hass, entry)
    await worker.async_start()
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = MachbarRuntime(publisher, worker)
    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))
    return True


async def _async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a Machbar config entry."""
    runtime: MachbarRuntime | None = hass.data.get(DOMAIN, {}).pop(
        entry.entry_id, None
    )
    if runtime is not None:
        await runtime.publisher.async_stop()
        await runtime.worker.async_stop()
    if not hass.data.get(DOMAIN):
        hass.data.pop(DOMAIN, None)
    return True
