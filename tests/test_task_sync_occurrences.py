"""Routine transport fails closed against old/unreachable servers before writing."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
import voluptuous as vol

from custom_components.machbar import _sync_task_schema
from custom_components.machbar.client import MachbarClient, UnsupportedVersion, RequestGone, CannotConnect
from custom_components.machbar.const import SYNC_TASK_PATH


@pytest.mark.parametrize("capabilities", [{}, {"occurrenceKeys": False}])
async def test_unsupported_server_never_receives_a_write(capabilities):
    client = MachbarClient(object(), "https://machbar.example", "test")
    with patch.object(client, "_request", AsyncMock()), patch.object(client, "_json", AsyncMock(return_value=capabilities)), patch.object(client, "_post", AsyncMock()) as post:
        with pytest.raises(UnsupportedVersion):
            await client.sync_task({"occurrenceKey": "2026-W46"})
        post.assert_not_awaited()


@pytest.mark.parametrize("failure", [RequestGone(), CannotConnect()])
async def test_failed_preflight_is_visible_and_does_not_write(failure):
    client = MachbarClient(object(), "https://machbar.example", "test")
    with patch.object(client, "_request", AsyncMock(side_effect=failure)), patch.object(client, "_post", AsyncMock()) as post:
        with pytest.raises(type(failure)):
            await client.sync_task({"occurrenceKey": "2026-W46"})
        post.assert_not_awaited()


async def test_supported_server_gets_the_same_occurrence_identity():
    client = MachbarClient(object(), "https://machbar.example", "test")
    payload = {"sourceKey": "lars-weekplan", "occurrenceKey": "2026-W46", "scheduledDate": "2026-11-10"}
    with patch.object(client, "_request", AsyncMock()) as request, patch.object(client, "_json", AsyncMock(side_effect=[{"occurrenceKeys": True}, {"taskId": 17}])), patch.object(client, "_post", AsyncMock(return_value=SimpleNamespace(status=200))) as post:
        assert await client.sync_task(payload) == {"taskId": 17}
        request.assert_awaited_once_with("GET", SYNC_TASK_PATH, authenticated=True)
        post.assert_awaited_once_with(SYNC_TASK_PATH, payload, authenticated=True)


@pytest.mark.parametrize("extra", [{"relevant": False}, {"scheduled_date": None}, {"title": ""}, {"reactivate_completed": True}])
def test_service_refuses_incomplete_or_reopening_routine_requests(extra):
    with pytest.raises(vol.Invalid):
        _sync_task_schema()({"config_entry_id": "test", "source_key": "lars-weekplan", "occurrence_key": "2026-W46", "relevant": True, "title": "Wochenplan", "scheduled_date": "2026-11-10", **extra})
