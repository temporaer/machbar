import { ObservationPlanEditor } from "./ObservationPlanEditor";
import type { ObservationPlan } from "@machbar/shared";
import { useState } from "react";
import {
  calendarDateForInstant,
  interventionTypes,
  type Intervention,
  type InterventionType,
} from "@machbar/shared";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { useHouseholdTimezone } from "../lib/householdTimezone";
import { addIsoCalendarDays, toIsoCalendarDate } from "../lib/naturalDate";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

export interface InterventionDraft {
  observationPlan?: ObservationPlan;
  type: InterventionType;
  commitment: string;
  rationale: string;
  startDate: string;
  revisitDate: string;
}

/**
 * Author or adjust the household-scale experiment backing a goal: the one
 * concrete commitment, its portfolio type, and the start/revisit window that
 * drives the derived running/finished progression (feature spec §4, §5). The
 * sheet only collects the draft; the Goals page commits it atomically.
 */
export function InterventionFormSheet({
  intervention,
  onClose,
  onSave,
}: {
  intervention?: Intervention;
  onClose: () => void;
  onSave: (draft: InterventionDraft) => Promise<void>;
}) {
  const strings = useStrings();
  const editing = intervention !== undefined;
  const { timezone, loaded } = useHouseholdTimezone();
  const todayIso =
    calendarDateForInstant(new Date().toISOString(), timezone) ??
    toIsoCalendarDate(new Date());

  const [observationPlan, setObservationPlan] = useState<ObservationPlan>(intervention?.observationPlan ?? { method: "reflection" });
  const [type, setType] = useState<InterventionType>(intervention?.type ?? "frequency_habit");
  const [commitment, setCommitment] = useState(intervention?.commitment ?? "");
  const [rationale, setRationale] = useState(intervention?.rationale ?? "");
  const [startDate, setStartDate] = useState(intervention?.startDate ?? todayIso);
  const [revisitDate, setRevisitDate] = useState(
    intervention?.revisitDate ?? addIsoCalendarDays(todayIso, 14),
  );
  const [startValid, setStartValid] = useState(true);
  const [revisitValid, setRevisitValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (saving) return;
    const trimmed = commitment.trim();
    if (!trimmed) {
      setError(strings.interventionCommitmentLabel);
      return;
    }
    if (!startDate || !revisitDate) {
      setError(strings.interventionRevisitInvalidHint);
      return;
    }
    if (revisitDate < startDate) {
      setError(strings.interventionRevisitInvalidHint);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...(JSON.stringify(observationPlan) !== JSON.stringify(intervention?.observationPlan) ? { observationPlan } : {}), type, commitment: trimmed, rationale: rationale.trim(), startDate, revisitDate });
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={editing ? strings.editIntervention : strings.startIntervention}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="stack">
        <div className="field">
          <span className="field-label">{strings.interventionTypeLabel}</span>
          <div className="choice-group" role="group" aria-label={strings.interventionTypeLabel}>
            {interventionTypes.map((value) => (
              <button
                key={value}
                type="button"
                className="choice-chip"
                aria-pressed={type === value}
                disabled={saving}
                onClick={() => setType(value)}
              >
                {strings.interventionTypeLabels[value]}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="field-label">{strings.interventionCommitmentLabel}</span>
          <input
            type="text"
            value={commitment}
            disabled={saving}
            placeholder={strings.interventionCommitmentHint}
            onChange={(event) => setCommitment(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">{strings.interventionRationaleLabel}</span>
          <textarea
            value={rationale}
            rows={2}
            disabled={saving}
            onChange={(event) => setRationale(event.target.value)}
          />
        </label>
        <div className="field">
          <span className="field-label">{strings.interventionStartDateLabel}</span>
          <HumanDateInput
            id="intervention-start-date"
            value={startDate}
            disabled={saving || !loaded}
            onChange={(date) => setStartDate(date ?? "")}
            onValidityChange={setStartValid}
          />
        </div>
        <div className="field">
          <span className="field-label">{strings.interventionRevisitDateLabel}</span>
          <HumanDateInput
            id="intervention-revisit-date"
            value={revisitDate}
            disabled={saving || !loaded}
            onChange={(date) => setRevisitDate(date ?? "")}
            onValidityChange={setRevisitValid}
          />
        </div>
        <ObservationPlanEditor value={observationPlan} onChange={setObservationPlan} disabled={saving} />
        {error ? (
          <div className="task-row-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !loaded || !startValid || !revisitValid}
            onClick={() => void submit()}
          >
            {strings.saveIntervention}
          </button>
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {strings.cancel}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
