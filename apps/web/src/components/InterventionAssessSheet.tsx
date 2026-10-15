import { useState } from "react";
import {
  assessmentBands,
  type AssessmentProposal,
  type AssessmentBand,
  type InterventionView,
} from "@machbar/shared";
import { hasApiErrorCode, localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

export interface AssessmentDraft {
  band: AssessmentBand;
  rationaleMd: string;
  countedItemIds: number[];
  digestWindowStart: string;
  digestWindowEnd: string;
  coachRequestId?: string;
}

function parseCountedItemIds(raw: string): number[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isInteger(value));
}

/**
 * The manual self-assessment path (feature spec §5, §9): with no AI configured
 * the user reviews the finished experiment, picks an outcome band, explains it,
 * optionally names the items they counted, and accepts. Mirrors the
 * intake/Klärungsrunde "review the proposal, edit, then explicitly accept"
 * interaction rather than owning its own transport.
 */
export function InterventionAssessSheet({
  intervention,
  onClose,
  onSave,
  onRequestCoach,
}: {
  intervention: InterventionView;
  onClose: () => void;
  onSave: (draft: AssessmentDraft) => Promise<void>;
  onRequestCoach: () => Promise<AssessmentProposal>;
}) {
  const strings = useStrings();
  const [band, setBand] = useState<AssessmentBand>("mostly_achieved");
  const [rationale, setRationale] = useState("");
  const [windowStart, setWindowStart] = useState(intervention.startDate);
  const [windowEnd, setWindowEnd] = useState(intervention.revisitDate);
  const [countedItems, setCountedItems] = useState("");
  const [startValid, setStartValid] = useState(true);
  const [endValid, setEndValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coachLoading, setCoachLoading] = useState(false);
  const [coachRequestId, setCoachRequestId] = useState<string | null>(null);

  const requestCoach = async () => {
    if (saving || coachLoading) return;
    setCoachLoading(true);
    setCoachRequestId(null);
    setError(null);
    try {
      const proposal = await onRequestCoach();
      if (
        proposal.status !== "ready" ||
        proposal.band === null ||
        proposal.rationaleMd === null
      ) {
        setError(
          proposal.status === "failed"
            ? proposal.error ?? strings.goalCoachAssessmentFailed
            : strings.goalCoachStillWorking,
        );
        return;
      }
      setBand(proposal.band);
      setRationale(proposal.rationaleMd);
      setCountedItems(proposal.countedItemIds.join(", "));
      setWindowStart(proposal.windowStart ?? intervention.startDate);
      setWindowEnd(proposal.windowEnd ?? intervention.revisitDate);
      setCoachRequestId(proposal.requestId);
    } catch (cause) {
      setError(
        hasApiErrorCode(cause, "home_assistant_not_connected")
          ? strings.goalCoachHomeAssistantUnavailable
          : hasApiErrorCode(cause, "ai_task_not_configured")
            ? strings.goalCoachAiTaskNotConfigured
            : localizedErrorMessage(cause, strings),
      );
    } finally {
      setCoachLoading(false);
    }
  };

  const submit = async () => {
    if (saving) return;
    const trimmedRationale = rationale.trim();
    if (!trimmedRationale) {
      setError(strings.assessmentRationaleLabel);
      return;
    }
    if (!windowStart || !windowEnd) {
      setError(strings.assessmentWindowStartLabel);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        band,
        rationaleMd: trimmedRationale,
        countedItemIds: parseCountedItemIds(countedItems),
        digestWindowStart: windowStart,
        digestWindowEnd: windowEnd,
        ...(coachRequestId ? { coachRequestId } : {}),
      });
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={strings.reviewIntervention}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="stack">
        <p className="text-muted">{intervention.commitment}</p>
        <div className="stack">
          <button
            type="button"
            className="btn"
            disabled={saving || coachLoading}
            onClick={() => void requestCoach()}
          >
            {coachLoading
              ? strings.goalCoachWorking
              : strings.goalCoachPrepareAssessment}
          </button>
          {coachRequestId ? (
            <p className="text-muted">{strings.goalCoachAssessmentReviewHint}</p>
          ) : null}
        </div>
        <div className="field">
          <span className="field-label">{strings.assessmentBandLabel}</span>
          <div className="choice-group" role="group" aria-label={strings.assessmentBandLabel}>
            {assessmentBands.map((value) => (
              <button
                key={value}
                type="button"
                className="choice-chip"
                aria-pressed={band === value}
                disabled={saving || coachLoading}
                onClick={() => setBand(value)}
              >
                {strings.assessmentBandLabels[value]}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="field-label">{strings.assessmentRationaleLabel}</span>
          <textarea
            value={rationale}
            rows={3}
            disabled={saving || coachLoading}
            onChange={(event) => setRationale(event.target.value)}
          />
        </label>
        <div className="field">
          <span className="field-label">{strings.assessmentWindowStartLabel}</span>
          <HumanDateInput
            id="assessment-window-start"
            value={windowStart}
            disabled={saving || coachLoading || coachRequestId !== null}
            onChange={(date) => setWindowStart(date ?? "")}
            onValidityChange={setStartValid}
          />
        </div>
        <div className="field">
          <span className="field-label">{strings.assessmentWindowEndLabel}</span>
          <HumanDateInput
            id="assessment-window-end"
            value={windowEnd}
            disabled={saving || coachLoading || coachRequestId !== null}
            onChange={(date) => setWindowEnd(date ?? "")}
            onValidityChange={setEndValid}
          />
        </div>
        <label className="field">
          <span className="field-label">{strings.assessmentCountedItemsLabel}</span>
          <input
            type="text"
            value={countedItems}
            inputMode="numeric"
            disabled={saving || coachLoading}
            placeholder={strings.assessmentCountedItemsHint}
            onChange={(event) => setCountedItems(event.target.value)}
          />
        </label>
        {error ? (
          <div className="task-row-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || coachLoading || !startValid || !endValid}
            onClick={() => void submit()}
          >
            {coachRequestId
              ? strings.goalCoachAcceptAssessment
              : strings.saveAssessment}
          </button>
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {strings.cancel}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
