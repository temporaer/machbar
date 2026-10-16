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


def _observation_plan_schema() -> vol.Schema:
    return vol.Schema(
        {
            _field("method", str): str,
            vol.Optional("question"): str,
            vol.Optional("reference"): str,
            vol.Optional("reportDayOffset"): int,
            vol.Optional("availableAfter"): str,
            vol.Optional("opportunityBased"): bool,
            vol.Optional("target"): vol.Schema(
                {
                    vol.Optional("successfulDays"): int,
                    vol.Optional("window"): str,
                    vol.Optional("anchorDate"): str,
                },
                extra=vol.PREVENT_EXTRA,
            ),
        },
        extra=vol.PREVENT_EXTRA,
    )


def _task_reminder_schema() -> vol.Schema:
    return vol.Schema(
        {
            vol.Optional("kind"): str,
            vol.Optional("at"): str,
            vol.Optional("daysBefore"): int,
            vol.Optional("time"): str,
            vol.Optional("timezone"): str,
        },
        extra=vol.PREVENT_EXTRA,
    )


def _intervention_task_schema() -> vol.Schema:
    return vol.Schema(
        {
            _field("key", str): str,
            _field("title", str): str,
            vol.Optional("notes"): str,
            vol.Optional("scheduledDate"): str,
            vol.Optional("dueDate"): str,
            vol.Optional("repeatAfterDays"): int,
            vol.Optional("allowedDeviationDays"): int,
            vol.Optional("reminders"): [_task_reminder_schema()],
        },
        extra=vol.PREVENT_EXTRA,
    )


def _suggest_intervention_schema() -> vol.Schema:
    return vol.Schema(
        {
            _field("type", str): str,
            _field("commitment", str): str,
            _field("rationale", str): str,
            _field("startDate", str): str,
            _field("revisitDate", str): str,
            vol.Optional("observationPlan"): _observation_plan_schema(),
            vol.Optional("tasks"): [_intervention_task_schema()],
        },
        extra=vol.PREVENT_EXTRA,
    )


GOAL_SUGGEST_STRUCTURE = vol.Schema(
    {
        vol.Optional("clarificationQuestion", default=None): _NULL,
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
        vol.Optional("countedObservationIds"): [int],
        vol.Optional("recommendedDecision"): str,
        vol.Optional("observationPlan"): _observation_plan_schema(),
        vol.Optional("commitment"): str,
        vol.Optional("nextRevisitDate"): str,
        vol.Optional("reminderEnabled"): bool,
    },
    extra=vol.PREVENT_EXTRA,
)


def _strip(value: Any) -> Any:
    return value.strip() if isinstance(value, str) else value


def normalize_goal_suggest_response(data: Any) -> dict[str, Any]:
    """Normalize the raw model envelope to the API's proposal DTO shape."""
    if not isinstance(data, dict) or not isinstance(data.get("interventions"), list):
        raise _invalid([], "an object with an interventions list", value=data)
    question = data.get("clarificationQuestion")
    if question is not None:
        if not isinstance(question, str) or not question.strip() or data["interventions"]:
            raise _invalid(["clarificationQuestion"], "one question without proposals", value=question)
        return {"clarificationQuestion": question.strip(), "interventions": []}
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
        normalized = {field: _strip(entry[field]) for field in required}
        if "observationPlan" in entry:
            if not isinstance(entry["observationPlan"], dict):
                raise _invalid(["interventions", index, "observationPlan"], "an observation plan object", value=entry["observationPlan"])
            normalized["observationPlan"] = entry["observationPlan"]
        if "tasks" in entry:
            if not isinstance(entry["tasks"], list) or any(not isinstance(task, dict) for task in entry["tasks"]):
                raise _invalid(["interventions", index, "tasks"], "a list of task proposals", value=entry["tasks"])
            normalized["tasks"] = entry["tasks"]
        interventions.append(normalized)
    return {"interventions": interventions}


def normalize_goal_assess_response(
    data: Any, candidate_item_ids: list[int] | None = None,
    candidate_observation_ids: list[int] | None = None, strict: bool = False,
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
    if strict and allowed is not None and any(item_id not in allowed for item_id in data["countedItemIds"]):
        raise _invalid(["countedItemIds"], "only provided evidence IDs", value=data["countedItemIds"])
    counted = [
        item_id for item_id in data["countedItemIds"]
        if allowed is None or item_id in allowed
    ]
    next_move = data.get("nextMove")
    if next_move is not None and not isinstance(next_move, str):
        raise _invalid(["nextMove"], "a string or null", value=next_move)
    observation_ids = data.get("countedObservationIds", [])
    if not isinstance(observation_ids, list) or any(not isinstance(value, int) or isinstance(value, bool) for value in observation_ids):
        raise _invalid(["countedObservationIds"], "integer observation IDs", value=observation_ids)
    if candidate_observation_ids is not None and any(value not in candidate_observation_ids for value in observation_ids):
        raise _invalid(["countedObservationIds"], "only provided observation IDs", value=observation_ids)
    if strict and ("countedObservationIds" not in data or data.get("recommendedDecision") not in ("continue", "adjust", "stop")):
        raise _invalid([], "observation references and a supported review decision", value=data)
    normalized = {
        "band": _strip(data["band"]),
        "rationaleMd": _strip(data["rationaleMd"]),
        "countedItemIds": counted,
        "nextMove": _strip(next_move),
    }
    if "countedObservationIds" in data:
        normalized["countedObservationIds"] = observation_ids
    for field in ("recommendedDecision", "observationPlan", "commitment", "nextRevisitDate", "reminderEnabled"):
        if field in data:
            normalized[field] = data[field]
    return normalized


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
    observation_ids = payload.get("candidateObservationIds")
    return normalize_goal_assess_response(data, candidates, observation_ids if isinstance(observation_ids, list) else None, payload.get("contractVersion") == 2)
