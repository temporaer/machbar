"""Tests for Machbar intake entity options."""

from types import SimpleNamespace
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry
from homeassistant.components.ai_task.const import AITaskEntityFeature
from homeassistant.components.calendar import CalendarEntityFeature
from homeassistant.components import ai_task, calendar

from custom_components.machbar.config_flow import MachbarOptionsFlow
from custom_components.machbar.const import DOMAIN


async def test_options_flow_saves_entities(hass):
    entry = MockConfigEntry(domain=DOMAIN, data={"origin": "http://x", "token": "t"})
    entry.add_to_hass(hass)
    hass.data[ai_task.DATA_COMPONENT] = SimpleNamespace(
        get_entity=lambda entity_id: SimpleNamespace(
            supported_features=AITaskEntityFeature.GENERATE_DATA
        )
    )
    hass.data[calendar.DATA_COMPONENT] = SimpleNamespace(
        get_entity=lambda entity_id: SimpleNamespace(
            supported_features=CalendarEntityFeature.CREATE_EVENT
        )
    )
    flow = MachbarOptionsFlow(entry)
    flow.hass = hass
    result = await flow.async_step_init(
        {"ai_task_entity_id": "ai_task.test", "calendar_entity_id": "calendar.test"}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"]["calendar_entity_id"] == "calendar.test"
