"""Home Assistant AI Task adapter for the Machbar Klärungsrunde."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from .intake import AdapterError, _invalid, ai_task_capabilities

_LOGGER = logging.getLogger(__name__)
_NULL = vol.Any(None, str)

PROPOSAL_KINDS = [
    "leave_alone",
    "rename_for_actionability",
    "clarify_goal",
    "clarify_next_decision",
    "wrong_shape",
    "split_thinking_from_execution",
    "identify_first_slice",
    "add_followup_after_incident",
    "define_check_or_rhythm",
    "clarify_recipient_or_document",
    "convert_to_reference",
]
RESOLUTION_SURFACES = [
    "mark_reviewed",
    "rename_item",
    "edit_done_when",
    "create_decision_task",
    "create_first_slice",
    "create_followup",
    "define_rhythm_or_revisit",
    "clarify_admin_target",
    "choose_shape",
    "split_clarify_execute",
    "convert_to_reference",
    "open_item",
]
WORK_TYPES = ["normal", "problem", "incident", "debt", "ops", "admin", "reference", "unknown"]
FLOWS = ["uphill", "downhill", "mixed", "unclear"]
CONFIDENCES = ["low", "medium", "high"]
SHAPES = ["task", "project", "reference"]

_RESULT_FIELDS = (
    "targetType",
    "targetId",
    "proposal",
    "resolutionSurface",
    "inferredWorkType",
    "inferredFlow",
    "confidence",
    "reason",
    "question",
    "suggestedDefault",
    "suggestedTitle",
    "suggestedShape",
)


def _field(key: str, allowed: list[str] | None = None) -> Any:
    return vol.Required(key, description=_description(key, allowed))


def _optional_field(key: str, allowed: list[str] | None = None) -> Any:
    return vol.Optional(key, default=None, description=_description(key, allowed))


def _description(key: str, allowed: list[str] | None) -> str:
    description = f"Machbar Klärungsrunde field {key}"
    return f"{description}; one of: {', '.join(allowed)}" if allowed else description


def _result_schema() -> vol.Schema:
    # Envelope only: vocabularies are guidance in the descriptions, not closed
    # enums. Machbar's API is the authoritative validator and accepts valid
    # entries while reporting malformed ones. REMOVE_EXTRA tolerates and drops
    # unknown keys while the provider schema keeps additionalProperties false,
    # which strict structured-output providers require.
    return vol.Schema(
        {
            _field("targetType", ["task", "project"]): str,
            _field("targetId"): int,
            _field("proposal", PROPOSAL_KINDS): str,
            _field("resolutionSurface", RESOLUTION_SURFACES): str,
            _field("inferredWorkType", WORK_TYPES): str,
            _field("inferredFlow", FLOWS): str,
            _field("confidence", CONFIDENCES): str,
            _field("reason"): str,
            _field("question"): str,
            _optional_field("suggestedDefault"): _NULL,
            _optional_field("suggestedTitle"): _NULL,
            _optional_field("suggestedShape", SHAPES): _NULL,
        },
        extra=vol.REMOVE_EXTRA,
    )


CLEANUP_ROUND_STRUCTURE = vol.Schema(
    {
        _field("summary"): str,
        _field("results"): [_result_schema()],
        _field("warnings"): [vol.Schema({_field("message"): str}, extra=vol.REMOVE_EXTRA)],
    },
    extra=vol.PREVENT_EXTRA,
)


def _strip(value: Any) -> Any:
    return value.strip() if isinstance(value, str) else value


def normalize_cleanup_response(data: Any) -> dict[str, Any]:
    """Return the CleanupRoundAiResponse envelope; Machbar validates every entry."""
    if not isinstance(data, dict):
        raise _invalid([], "an object", value=data)
    results = data.get("results")
    if not isinstance(results, list):
        raise _invalid(["results"], "a list", value=results)
    summary = _strip(data.get("summary"))
    warnings = data.get("warnings")
    normalized_results: list[Any] = []
    for entry in results:
        if not isinstance(entry, dict):
            # Malformed entries are forwarded so Machbar can report them.
            normalized_results.append(entry)
            continue
        normalized = {key: _strip(entry[key]) for key in _RESULT_FIELDS if key in entry}
        target_id = normalized.get("targetId")
        if isinstance(target_id, str) and target_id.isdigit():
            normalized["targetId"] = int(target_id)
        normalized_results.append(normalized)
    return {
        "summary": summary if isinstance(summary, str) else "",
        "results": normalized_results,
        "warnings": [
            {"message": _strip(item["message"])}
            for item in (warnings if isinstance(warnings, list) else [])
            if isinstance(item, dict) and isinstance(item.get("message"), str)
        ],
    }


async def async_analyze_cleanup_round(
    hass: Any, entity_id: str | None, payload: dict[str, Any]
) -> dict[str, Any]:
    from homeassistant.components import ai_task

    if ai_task_capabilities(hass, entity_id)["state"] != "ok":
        raise AdapterError("ai_task_not_configured")
    try:
        result = await ai_task.task.async_generate_data(
            hass,
            task_name=payload.get("taskName", "Machbar Klärungsrunde"),
            entity_id=entity_id,
            instructions=payload.get("instructions", ""),
            structure=CLEANUP_ROUND_STRUCTURE,
        )
    except Exception as err:
        _LOGGER.exception("Machbar Klärungsrunde generation failed")
        raise AdapterError("ai_task_failed") from err
    return normalize_cleanup_response(result.data)
