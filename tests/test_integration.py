"""Tests for Machbar snapshot publishing."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.exceptions import ConfigEntryAuthFailed
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.machbar import SnapshotPublisher, async_setup_entry
from custom_components.machbar.client import InvalidAuth
from custom_components.machbar.const import DOMAIN
from custom_components.machbar.snapshot import build_snapshot


@pytest.fixture(autouse=True)
def mock_managed_session():
    """Avoid aiohttp worker threads while HTTP calls are mocked."""
    with patch(
        "custom_components.machbar.async_get_clientsession", return_value=object()
    ):
        yield


def _entry() -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN,
        data={
            "origin": "https://machbar.example",
            "token": "secret-token",
            "instanceId": "instance-1",
            "protocolVersion": 2,
        },
        unique_id="instance-1",
    )


async def test_setup_and_reload_push_initial_snapshot(hass):
    """Every setup, including setup after reload, publishes current state."""
    hass.states.async_set(
        "zone.home",
        "1",
        {"friendly_name": "Home", "latitude": 1.2, "longitude": 3.4},
    )
    hass.states.async_set(
        "person.alex",
        "home",
        {"friendly_name": "Alex", "in_zones": ["zone.home"]},
    )
    entry = _entry()
    entry.add_to_hass(hass)

    push = AsyncMock()
    with patch(
        "custom_components.machbar.client.MachbarClient.push_snapshot", push
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        assert push.await_count == 1
        assert await hass.config_entries.async_reload(entry.entry_id)
        assert push.await_count == 2
        assert await hass.config_entries.async_unload(entry.entry_id)

    snapshot = push.await_args_list[0].args[0]
    assert snapshot["people"][0]["contexts"] == ["zone.home"]
    assert "latitude" not in str(snapshot)
    assert "longitude" not in str(snapshot)


async def test_setup_reports_invalid_credentials(hass):
    """Revoked integration credentials trigger Home Assistant reauthentication."""
    entry = _entry()
    with patch(
        "custom_components.machbar.client.MachbarClient.push_snapshot",
        AsyncMock(side_effect=InvalidAuth),
    ):
        with pytest.raises(ConfigEntryAuthFailed):
            await async_setup_entry(hass, entry)


async def test_state_change_pushes_complete_snapshot(hass):
    """Relevant changes are coalesced into one fresh complete snapshot."""
    hass.states.async_set("zone.home", "0", {"friendly_name": "Home"})
    hass.states.async_set("person.alex", "not_home", {"friendly_name": "Alex"})
    entry = _entry()
    push = AsyncMock()
    publisher = SnapshotPublisher(hass, entry)

    with (
        patch(
            "custom_components.machbar.client.MachbarClient.push_snapshot", push
        ),
        patch(
            "custom_components.machbar.PUSH_DELAY_SECONDS", 0
        ),
    ):
        await publisher.async_start()
        hass.states.async_set(
            "person.alex",
            "home",
            {"friendly_name": "Alex", "in_zones": ["zone.home"]},
        )
        hass.states.async_set("zone.home", "1", {"friendly_name": "Home"})
        await asyncio.sleep(0.01)
        await hass.async_block_till_done()

    assert push.await_count == 2
    snapshot = push.await_args.args[0]
    assert snapshot["protocolVersion"] == 2
    assert "intake" in snapshot
    assert snapshot["contexts"] == [
        {"externalId": "zone.home", "name": "Home"}
    ]
    assert snapshot["people"] == [
        {
            "externalId": "person.alex",
            "name": "Alex",
            "state": "known",
            "contexts": ["zone.home"],
        }
    ]
    await publisher.async_stop()


async def test_unload_cleans_up_listener_and_pending_push(hass):
    """Unloading prevents queued and future events from being published."""
    hass.states.async_set("zone.home", "0")
    entry = _entry()
    push = AsyncMock()
    publisher = SnapshotPublisher(hass, entry)

    with patch(
        "custom_components.machbar.client.MachbarClient.push_snapshot", push
    ):
        await publisher.async_start()
        hass.states.async_set("person.alex", "home")
        await publisher.async_stop()
        hass.states.async_set("person.alex", "not_home")
        await hass.async_block_till_done()

    push.assert_awaited_once()


async def test_sync_task_service_maps_reactivation_and_note_options(hass):
    """The HA service forwards optional reconciliation controls in API casing."""
    entry = _entry()
    entry.add_to_hass(hass)
    with (
        patch(
            "custom_components.machbar.client.MachbarClient.push_snapshot",
            AsyncMock(),
        ),
        patch(
            "custom_components.machbar.client.MachbarClient.sync_task",
            AsyncMock(),
        ) as sync_task,
        patch(
            "custom_components.machbar.worker.RequestWorker.async_start",
            AsyncMock(),
        ),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.services.async_call(
            DOMAIN,
            "sync_task",
            {
                "config_entry_id": entry.entry_id,
                "source_key": "service:test",
                "relevant": True,
                "reactivate_completed": True,
                "overwrite_notes": True,
                "notes": None,
            },
            blocking=True,
        )
        sync_task.assert_awaited_once_with({
            "sourceKey": "service:test",
            "relevant": True,
            "reactivateCompleted": True,
            "overwriteNotes": True,
            "notes": None,
        })
        await hass.config_entries.async_unload(entry.entry_id)


async def test_sync_task_service_maps_nullable_deadline_reminder_and_omits_it_when_absent(hass):
    """Deadline reminder payloads use the API contract and omitted values stay omitted."""
    entry = _entry()
    entry.add_to_hass(hass)
    with (
        patch(
            "custom_components.machbar.client.MachbarClient.push_snapshot",
            AsyncMock(),
        ),
        patch(
            "custom_components.machbar.client.MachbarClient.sync_task",
            AsyncMock(),
        ) as sync_task,
        patch(
            "custom_components.machbar.worker.RequestWorker.async_start",
            AsyncMock(),
        ),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        base = {
            "config_entry_id": entry.entry_id,
            "source_key": "service:deadline",
            "relevant": True,
        }
        await hass.services.async_call(
            DOMAIN,
            "sync_task",
            {
                **base,
                "deadline_reminder": {
                    "days_before": 1,
                    "time": "19:00",
                    "timezone": "Europe/Berlin",
                },
            },
            blocking=True,
        )
        await hass.services.async_call(
            DOMAIN,
            "sync_task",
            {**base, "source_key": "service:omitted"},
            blocking=True,
        )
        assert sync_task.await_args_list[0].args[0]["deadlineReminder"] == {
            "daysBefore": 1,
            "time": "19:00",
            "timezone": "Europe/Berlin",
        }
        assert "deadlineReminder" not in sync_task.await_args_list[1].args[0]
        await hass.config_entries.async_unload(entry.entry_id)


@pytest.mark.parametrize(
    ("state", "in_zones", "expected_state", "expected_contexts"),
    [
        ("home", ["zone.home"], "known", ["zone.home"]),
        ("Büro", ["zone.microsoft"], "known", ["zone.microsoft"]),
        ("not_home", [], "known", []),
        ("unknown", ["zone.home"], "unknown", []),
        ("unavailable", ["zone.home"], "unknown", []),
        (
            "home",
            ["zone.home", "zone.garden"],
            "known",
            ["zone.home", "zone.garden"],
        ),
        ("home", ["zone.home", "zone.unsynchronized"], "known", ["zone.home"]),
    ],
)
def test_person_snapshot_uses_actual_zone_memberships(
    hass, state, in_zones, expected_state, expected_contexts
):
    """Snapshots preserve known empty states and filter zone memberships."""
    for zone_id in ("zone.home", "zone.microsoft", "zone.garden"):
        hass.states.async_set(zone_id, "0")
    hass.states.async_set(
        "person.alex",
        state,
        {
            "in_zones": in_zones,
            "latitude": 1.2,
            "longitude": 3.4,
            "gps_accuracy": 10,
        },
    )

    person = build_snapshot(hass)["people"][0]
    assert person["state"] == expected_state
    assert person["contexts"] == expected_contexts
    assert set(person) == {"externalId", "name", "state", "contexts"}
