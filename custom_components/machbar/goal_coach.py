"""Home Assistant AI Task adapters for the Machbar goal coach."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from .intake import AdapterError, _invalid, ai_task_capabilities

_LOGGER = logging.getLogger(__name__)
_NULL = vol.Any(None, str)


def _field(name: str, schema: Any) -> Any:
    return vol.Required(name, description=f"Machbar goal coach field {name}")


def _suggest_intervention_schema() -> vol.Schema:
    return vol.Schema(
        {
            _field("type", str): str,
            _field("commitment", str): str,
            _field("rationale", str): str,
            _field("startDate", str): str,
            _field("revisitDate", str): str,
        },
        extra=vol.PREVENT_EXTRA,
    )


GOAL_SUGGEST_STRUCTURE = vol.Schema(
    {
        _field("interventions", [_suggest_intervention_schema()]): [
            _suggest_intervention_schema()
        ],
    },
    extra=vol.PREVENT_EXTRA,
)

GOAL_ASSESS_STRUCTURE = vol.Schema(
    {
        _field("band", str): str,
        _field("rationaleMd", str): str,
        _field("countedItemIds", [int]): [int],
        vol.Optional("nextMove", default=None): _NULL,
    },
    extra=vol.PREVENT_EXTRA,
)


def _strip(value: Any) -> Any:
    return value.strip() if isinstance(value, str) else value


def normalize_goal_suggest_response(data: Any) -> dict[str, Any]:
    """Normalize the raw model envelope to the API's proposal DTO shape."""
    if not isinstance(data, dict) or not isinstance(data.get("interventions"), list):
        raise _invalid([], "an object with an interventions list", value=data)
    interventions: list[dict[str, Any]] = []
    for index, entry in enumerate(data["interventions"]):
        if not isinstance(entry, dict):
            raise _invalid(["interventions", index], "an intervention object", value=entry)
        required = ("type", "commitment", "rationale", "startDate", "revisitDate")
        if any(not isinstance(entry.get(field), str) for field in required):
            raise _invalid(
                ["interventions", index],
                "an intervention with string type, commitment, rationale, startDate, and revisitDate",
                value=entry,
            )
        interventions.append(
            {field: _strip(entry[field]) for field in required}
        )
    return {"interventions": interventions}


def normalize_goal_assess_response(
    data: Any, candidate_item_ids: list[int] | None = None
) -> dict[str, Any]:
    """Normalize an assessment and constrain cited evidence to candidate IDs."""
    if not isinstance(data, dict):
        raise _invalid([], "an assessment object", value=data)
    required = ("band", "rationaleMd", "countedItemIds")
    if any(field not in data for field in required):
        raise _invalid([], "an assessment with band, rationaleMd, and countedItemIds", value=data)
    if not isinstance(data["band"], str) or not isinstance(data["rationaleMd"], str):
        raise _invalid([], "string band and rationaleMd", value=data)
    if not isinstance(data["countedItemIds"], list) or any(
        not isinstance(item_id, int) or isinstance(item_id, bool)
        for item_id in data["countedItemIds"]
    ):
        raise _invalid(["countedItemIds"], "a list of integer IDs", value=data["countedItemIds"])
    allowed = set(candidate_item_ids) if candidate_item_ids is not None else None
    counted = [
        item_id for item_id in data["countedItemIds"]
        if allowed is None or item_id in allowed
    ]
    next_move = data.get("nextMove")
    if next_move is not None and not isinstance(next_move, str):
        raise _invalid(["nextMove"], "a string or null", value=next_move)
    return {
        "band": _strip(data["band"]),
        "rationaleMd": _strip(data["rationaleMd"]),
        "countedItemIds": counted,
        "nextMove": _strip(next_move),
    }


async def _generate(
    hass: Any,
    entity_id: str | None,
    payload: dict[str, Any],
    structure: vol.Schema,
) -> Any:
    from homeassistant.components import ai_task

    if ai_task_capabilities(hass, entity_id)["state"] != "ok":
        raise AdapterError("ai_task_not_configured")
    try:
        result = await ai_task.task.async_generate_data(
            hass,
            task_name=payload.get("taskName", "Machbar Zielcoach"),
            entity_id=entity_id,
            instructions=payload.get("instructions", ""),
            structure=structure,
        )
    except Exception as err:
        _LOGGER.exception("Machbar goal coach AI Task generation failed")
        raise AdapterError("ai_task_failed") from err
    return result.data


async def async_analyze_goal_suggest(
    hass: Any, entity_id: str | None, payload: dict[str, Any]
) -> dict[str, Any]:
    data = await _generate(hass, entity_id, payload, GOAL_SUGGEST_STRUCTURE)
    return normalize_goal_suggest_response(data)


async def async_analyze_goal_assess(
    hass: Any, entity_id: str | None, payload: dict[str, Any]
) -> dict[str, Any]:
    data = await _generate(hass, entity_id, payload, GOAL_ASSESS_STRUCTURE)
    candidate_ids = payload.get("candidateItemIds")
    candidates = candidate_ids if isinstance(candidate_ids, list) else None
    return normalize_goal_assess_response(data, candidates)
