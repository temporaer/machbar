import { useState } from "react";
import {
  assessmentBands,
  type AssessmentBand,
  type InterventionView,
} from "@machbar/shared";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

export interface AssessmentDraft {
  band: AssessmentBand;
  rationaleMd: string;
  countedItemIds: number[];
  digestWindowStart: string;
  digestWindowEnd: string;
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
}: {
  intervention: InterventionView;
  onClose: () => void;
  onSave: (draft: AssessmentDraft) => Promise<void>;
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
        <div className="field">
          <span className="field-label">{strings.assessmentBandLabel}</span>
          <div className="choice-group" role="group" aria-label={strings.assessmentBandLabel}>
            {assessmentBands.map((value) => (
              <button
                key={value}
                type="button"
                className="choice-chip"
                aria-pressed={band === value}
                disabled={saving}
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
            disabled={saving}
            onChange={(event) => setRationale(event.target.value)}
          />
        </label>
        <div className="field">
          <span className="field-label">{strings.assessmentWindowStartLabel}</span>
          <HumanDateInput
            id="assessment-window-start"
            value={windowStart}
            disabled={saving}
            onChange={(date) => setWindowStart(date ?? "")}
            onValidityChange={setStartValid}
          />
        </div>
        <div className="field">
          <span className="field-label">{strings.assessmentWindowEndLabel}</span>
          <HumanDateInput
            id="assessment-window-end"
            value={windowEnd}
            disabled={saving}
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
            disabled={saving}
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
            disabled={saving || !startValid || !endValid}
            onClick={() => void submit()}
          >
            {strings.saveAssessment}
          </button>
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {strings.cancel}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
