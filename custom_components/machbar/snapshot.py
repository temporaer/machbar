"""Build privacy-preserving Home Assistant physical-context snapshots."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import HomeAssistant, State

from .const import PROTOCOL_VERSION

_ATTR_IN_ZONES = "in_zones"


def _name(state: State) -> str:
    return str(state.attributes.get("friendly_name") or state.name)


def build_snapshot(hass: HomeAssistant) -> dict[str, Any]:
    """Build a complete snapshot without transmitting coordinates."""
    zone_states = sorted(
        hass.states.async_all("zone"), key=lambda state: state.entity_id
    )
    context_ids = {state.entity_id for state in zone_states}
    contexts = [
        {
            "externalId": state.entity_id,
            "name": _name(state),
        }
        for state in zone_states
    ]

    people = []
    for person in sorted(
        hass.states.async_all("person"), key=lambda state: state.entity_id
    ):
        known = person.state not in (STATE_UNKNOWN, STATE_UNAVAILABLE)
        zone_ids = person.attributes.get(_ATTR_IN_ZONES, [])
        people.append(
            {
                "externalId": person.entity_id,
                "name": _name(person),
                "state": "known" if known else "unknown",
                "contexts": [
                    zone_id for zone_id in zone_ids if zone_id in context_ids
                ]
                if known
                else [],
            }
        )

    return {
        "protocolVersion": PROTOCOL_VERSION,
        "observedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "contexts": contexts,
        "people": people,
    }
