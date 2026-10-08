import { useEffect, useState } from "react";
import {
  calendarDateForInstant,
  type Project,
} from "@machbar/shared";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { addIsoCalendarDays, toIsoCalendarDate } from "../lib/naturalDate";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";
import { taskAvailabilityForLocalDate } from "../lib/taskAvailability";
import { useHouseholdTimezone } from "../lib/householdTimezone";

function toRevisitAt(date: string, timezone: string): string | null {
  return taskAvailabilityForLocalDate(date, "00:00", timezone)?.notBeforeAt ?? null;
}

/**
 * The canonical `story.defer` workflow, separate from deadline editing.
 * `revisitAt` has explicit semantics for a project
 * ("before this instant, this project is intentionally not relevant"), so
 * the question is "Bis wann zurückstellen?" with convenience shortcuts.
 */
export function ProjectDeferSheet({
  story,
  onClose,
  onSave,
}: {
  story: Project;
  onClose: () => void;
  onSave: (patch: { revisitAt: string | null }) => Promise<void>;
}) {
  const strings = useStrings();
  const { timezone: householdTimezone, loaded: timezoneLoaded } =
    useHouseholdTimezone();
  const [customDate, setCustomDate] = useState(false);
  const [dateDraftChanged, setDateDraftChanged] = useState(false);
  const [revisitDate, setRevisitDate] = useState(
    story.revisitAt
      ? calendarDateForInstant(story.revisitAt, householdTimezone) ?? ""
      : "",
  );
  const [dateValid, setDateValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = () =>
    calendarDateForInstant(new Date().toISOString(), householdTimezone) ??
    toIsoCalendarDate(new Date());

  useEffect(() => {
    if (dateDraftChanged) return;
    setRevisitDate(
      story.revisitAt
        ? calendarDateForInstant(story.revisitAt, householdTimezone) ?? ""
        : "",
    );
  }, [dateDraftChanged, householdTimezone, story.revisitAt]);

  const commit = async (patch: { revisitAt: string | null }) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={story.status === "active" ? strings.deferProject : strings.revisit}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="stack">
        <p className="text-muted">{story.title}</p>
        <div className="field">
          <span className="field-label">{strings.projectDeferQuestion}</span>
          <div className="choice-group" role="group" aria-label={strings.projectDeferQuestion}>
            <button
              type="button"
              className="choice-chip"
              disabled={saving || !timezoneLoaded}
              onClick={() => void commit({ revisitAt: toRevisitAt(addIsoCalendarDays(today(), 1), householdTimezone) })}
            >
              {strings.projectDeferShortcutLabels.tomorrow}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving || !timezoneLoaded}
              onClick={() => void commit({ revisitAt: toRevisitAt(addIsoCalendarDays(today(), 7), householdTimezone) })}
            >
              {strings.projectDeferShortcutLabels.nextWeek}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving || !timezoneLoaded}
              onClick={() => void commit({ revisitAt: toRevisitAt(addIsoCalendarDays(today(), 14), householdTimezone) })}
            >
              {strings.projectDeferShortcutLabels.twoWeeks}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving || !timezoneLoaded}
              onClick={() => void commit({ revisitAt: toRevisitAt(addIsoCalendarDays(today(), 30), householdTimezone) })}
            >
              {strings.projectDeferShortcutLabels.nextMonth}
            </button>
            <button
              type="button"
              className="choice-chip"
              disabled={saving || !timezoneLoaded}
              onClick={() => void commit({ revisitAt: null })}
            >
              {strings.projectDeferWithoutRevisit}
            </button>
            <button
              type="button"
              className="choice-chip"
              aria-pressed={customDate}
              disabled={saving || !timezoneLoaded}
              onClick={() => setCustomDate(true)}
            >
              {strings.pickDate}
            </button>
          </div>
          {customDate ? (
            <div className="row">
              <HumanDateInput
                id="project-defer-date"
                value={revisitDate}
                onChange={(date) => {
                  setRevisitDate(date ?? "");
                  setDateDraftChanged(true);
                }}
                onValidityChange={setDateValid}
                disabled={saving || !timezoneLoaded}
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={saving || !timezoneLoaded || !dateValid}
                onClick={() => void commit({ revisitAt: revisitDate ? toRevisitAt(revisitDate, householdTimezone) : null })}
              >
                {strings.save}
              </button>
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="task-row-error" role="alert">
            {error}
          </div>
        ) : null}
        <button type="button" className="btn" disabled={saving} onClick={onClose}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
