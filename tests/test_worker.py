"""Tests for the Machbar request worker."""

from unittest.mock import AsyncMock, patch

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.machbar.const import DOMAIN
from custom_components.machbar.worker import RequestWorker


async def test_worker_handles_empty_poll(hass):
    entry = MockConfigEntry(
        domain=DOMAIN, data={"origin": "http://x", "token": "t"}, options={}
    )
    with patch(
        "custom_components.machbar.worker.MachbarClient.next_request",
        AsyncMock(return_value=None),
    ), patch("custom_components.machbar.async_get_clientsession", return_value=object()):
        worker = RequestWorker(hass, entry)
        await worker.async_start()
        await worker.async_stop()
