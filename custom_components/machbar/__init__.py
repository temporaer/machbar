"""Machbar Home Assistant integration."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.exceptions import (
    ConfigEntryAuthFailed,
    ConfigEntryNotReady,
    ServiceValidationError,
)
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers import selector
import voluptuous as vol

from .client import CannotConnect, InvalidAuth, MachbarClient, MachbarError
from .const import (
    CONF_ORIGIN,
    CONF_TOKEN,
    DOMAIN,
    PUSH_DELAY_SECONDS,
)
from .snapshot import build_snapshot

_LOGGER = logging.getLogger(__name__)
SERVICE_SYNC_TASK = "sync_task"


def _sync_task_schema() -> vol.Schema:
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
            vol.Optional("priority"): vol.Any(int, None),
            vol.Optional("size"): vol.Any(vol.In(["S", "M", "L", "XL"]), None),
        }
    )


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
            ("priority", "priority"),
            ("size", "size"),
        ):
            if source in call.data:
                payload[target_name] = call.data[source]
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
        if not entity_id.startswith(("person.", "zone.")):
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
        await self._client.push_snapshot(build_snapshot(self._hass))

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

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = publisher
    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))
    return True


async def _async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a Machbar config entry."""
    publisher: SnapshotPublisher | None = hass.data.get(DOMAIN, {}).pop(
        entry.entry_id, None
    )
    if publisher is not None:
        await publisher.async_stop()
    if not hass.data.get(DOMAIN):
        hass.data.pop(DOMAIN, None)
    return True
