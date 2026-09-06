"""Machbar Home Assistant integration."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later

from .client import CannotConnect, InvalidAuth, MachbarClient, MachbarError
from .const import (
    CONF_ORIGIN,
    CONF_TOKEN,
    DOMAIN,
    PUSH_DELAY_SECONDS,
)
from .snapshot import build_snapshot

_LOGGER = logging.getLogger(__name__)


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
