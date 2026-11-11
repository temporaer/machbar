"""Execute the shipped HA script against controlled school-day states."""
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import yaml
from freezegun import freeze_time
from homeassistant.exceptions import HomeAssistantError
from homeassistant.setup import async_setup_component
from homeassistant.components.trace.const import DATA_TRACE

EXAMPLE = yaml.safe_load((Path(__file__).resolve().parents[1] / "docs/examples/home-assistant-school-routines.yaml").read_text())


async def setup_routine(hass, *, vacation="kein_ferientag", holiday="kein_feiertag", combined="off", workday="on", fail=False):
    await hass.config.async_set_time_zone("Europe/Berlin")
    for entity, value in [("sensor.schulferien_de_bw", vacation), ("sensor.feiertag_de_bw", holiday), ("binary_sensor.schulferien_feiertage_de_bw", combined), ("binary_sensor.workday_sensor", workday)]:
        hass.states.async_set(entity, value)
    call = AsyncMock(side_effect=HomeAssistantError("Machbar unreachable") if fail else None)
    hass.services.async_register("machbar", "sync_task", call)
    hass.services.async_register("system_log", "write", AsyncMock())
    assert await async_setup_component(hass, "script", {"script": EXAMPLE["script"]})
    return call


@pytest.mark.parametrize(("vacation", "holiday", "combined", "workday", "expected"), [
    ("kein_ferientag", "kein_feiertag", "off", "on", 1),
    ("ferientag", "kein_feiertag", "on", "on", 0),
    ("kein_ferientag", "feiertag", "on", "off", 0),
])
async def test_monday_school_vacation_and_public_holiday(hass, vacation, holiday, combined, workday, expected):
    with freeze_time("2026-11-09T15:00:00Z"):
        call = await setup_routine(hass, vacation=vacation, holiday=holiday, combined=combined, workday=workday)
        await hass.services.async_call("script", "machbar_lars_schulroutine", {"routine": "weekplan", "dry_run": False}, blocking=True)
        assert call.await_count == expected
        if expected:
            data = call.await_args.args[0].data
            assert data["occurrence_key"] == "2026-W46"
            assert data["scheduled_date"] == "2026-11-09"
            assert "due_date" not in data
            assert "repeatAfterDays" not in data


async def test_tuesday_recovery_and_double_trigger_keep_the_week_key(hass):
    with freeze_time("2026-11-10T15:15:00Z"):
        call = await setup_routine(hass)
        for _ in range(2):
            await hass.services.async_call("script", "machbar_lars_schulroutine", {"routine": "weekplan", "dry_run": False}, blocking=True)
        assert call.await_count == 2
        assert all(c.args[0].data["occurrence_key"] == "2026-W46" for c in call.await_args_list)
        assert all(c.args[0].data["scheduled_date"] == "2026-11-10" for c in call.await_args_list)


@pytest.mark.parametrize("unknown", ["unknown", "unavailable"])
async def test_missing_raw_source_blocks_even_with_false_off_combined_sensor(hass, unknown):
    with freeze_time("2026-11-09T15:00:00Z"):
        call = await setup_routine(hass, vacation=unknown)
        await hass.services.async_call("script", "machbar_lars_schulroutine", {"routine": "weekplan", "dry_run": False}, blocking=True)
        call.assert_not_awaited()
        traces = [trace.as_extended_dict() for group in hass.data[DATA_TRACE].values() for trace in group.values()]
        assert any(trace["script_execution"] == "aborted" for trace in traces)
        assert any("Ferien-/Feiertagsdaten unbekannt" in str(trace) for trace in traces)


async def test_machbar_failure_propagates_out_of_the_script(hass):
    with freeze_time("2026-11-09T15:00:00Z"):
        await setup_routine(hass, fail=True)
        with pytest.raises(HomeAssistantError, match="Machbar unreachable"):
            await hass.services.async_call("script", "machbar_lars_schulroutine", {"routine": "weekplan", "dry_run": False}, blocking=True)


@pytest.mark.parametrize(("instant", "routine", "dry_run", "expected"), [
    ("2026-11-13T15:00:00Z", "mailbags", False, 1),
    ("2026-11-10T15:00:00Z", "mailbags", False, 0),
    ("2026-11-09T19:00:00Z", "weekplan", False, 0),
    ("2026-11-09T14:59:00Z", "weekplan", False, 0),
    ("2026-11-09T15:00:00Z", "weekplan", True, 0),

])
async def test_friday_only_no_late_backfill_and_manual_preview(hass, instant, routine, dry_run, expected):
    with freeze_time(instant):
        call = await setup_routine(hass)
        await hass.services.async_call("script", "machbar_lars_schulroutine", {"routine": routine, "dry_run": dry_run}, blocking=True)
        assert call.await_count == expected
