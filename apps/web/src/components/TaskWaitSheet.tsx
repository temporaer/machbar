import { useMemo, useState } from "react";
import type { Member, Task } from "@machbar/shared";
import {
  extractCaptionHints,
  strongestCaptionHints,
  type TemporalCaptionHint,
  type WaitingCaptionHint,
} from "../lib/captionHints";
import { useLocale } from "../lib/locale";
import { useStrings } from "../lib/strings";
import { useTaskActions } from "../lib/useTaskActions";
import { localizedErrorMessage } from "../lib/errorMessage";
import { addIsoCalendarDays, toIsoCalendarDate } from "../lib/naturalDate";
import { formatExactLocalDate } from "../lib/relativeDate";
import { BottomSheet } from "./BottomSheet";
import { CaptionHintSuggestions } from "./CaptionHintSuggestions";
import { HumanDateInput } from "./HumanDateInput";

/**
 * The canonical `task.waitingLifecycle` workflow for a task with no
 * external wait yet — `TaskWorkflowHost` resolves to this component
 * instead of `WaitingFollowUpSheet` once `task.externalWait` is null (see
 * that component for the "already waiting" case).
 */
export function TaskWaitSheet({
  task,
  members,
  onClose,
}: {
  task: Task;
  members: Member[];
  onClose: () => void;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const taskActions = useTaskActions();
  const [waitingFor, setWaitingFor] = useState("");
  const [revisitDate, setRevisitDate] = useState<string | null>(null);
  const [customDate, setCustomDate] = useState(false);
  const [dateValid, setDateValid] = useState(true);
  const saving = taskActions.isPending(task.id);
  const error = taskActions.errors[task.id] ?? null;
  const captionHints = useMemo(
    () =>
      extractCaptionHints(task.title, {
        locale,
        referenceDate: new Date(task.createdAt),
        members,
      }),
    [locale, members, task.createdAt, task.title],
  );
  const waitingHints = strongestCaptionHints(
    captionHints.filter(
      (hint): hint is WaitingCaptionHint => hint.kind === "waiting",
    ),
  );
  const revisitHints = strongestCaptionHints(
    captionHints.filter(
      (hint): hint is TemporalCaptionHint =>
        hint.kind === "temporal" && hint.semantic === "followUp",
    ),
  );

  const today = () => toIsoCalendarDate(new Date());

  const commit = async () => {
    if (saving || !waitingFor.trim() || !dateValid) return;
    taskActions.clearError(task.id);
    const updated = await taskActions.setExternalWait(
      task,
      { waitingFor: waitingFor.trim(), revisitDate },
      { throwOnError: false },
    );
    if (updated) onClose();
  };

  return (
    <BottomSheet
      title={`${strings.markAsWaiting}: ${task.title}`}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void commit();
        }}
      >
        <div className="field">
          <label htmlFor={`wait-for-${task.id}`}>{strings.taskWaitQuestion}</label>
          <input
            id={`wait-for-${task.id}`}
            type="text"
            value={waitingFor}
            placeholder={strings.waitingForPlaceholder}
            disabled={saving}
            autoFocus
            onChange={(event) => setWaitingFor(event.target.value)}
          />
          <CaptionHintSuggestions
            hints={waitingHints.map((hint) => ({
              key: hint.key,
              label: hint.waitingFor,
            }))}
            disabled={saving}
            onSelect={(key) => {
              const hint = waitingHints.find(
                (candidate) => candidate.key === key,
              );
              if (hint) setWaitingFor(hint.waitingFor);
            }}
          />
        </div>

        <div className="field">
          <span className="field-label">{strings.taskWaitRevisitQuestion}</span>
          <div className="choice-group" role="group" aria-label={strings.taskWaitRevisitQuestion}>
            <button
              type="button"
              className="choice-chip"
              aria-pressed={!customDate && revisitDate === addIsoCalendarDays(today(), 1)}
              disabled={saving}
              onClick={() => {
                setCustomDate(false);
                setRevisitDate(addIsoCalendarDays(today(), 1));
              }}
            >
              {strings.revisitShortcutLabels.tomorrow}
            </button>
            <button
              type="button"
              className="choice-chip"
              aria-pressed={!customDate && revisitDate === addIsoCalendarDays(today(), 3)}
              disabled={saving}
              onClick={() => {
                setCustomDate(false);
                setRevisitDate(addIsoCalendarDays(today(), 3));
              }}
            >
              {strings.revisitShortcutLabels.threeDays}
            </button>
            <button
              type="button"
              className="choice-chip"
              aria-pressed={!customDate && revisitDate === addIsoCalendarDays(today(), 7)}
              disabled={saving}
              onClick={() => {
                setCustomDate(false);
                setRevisitDate(addIsoCalendarDays(today(), 7));
              }}
            >
              {strings.revisitShortcutLabels.oneWeek}
            </button>
            <button
              type="button"
              className="choice-chip"
              aria-pressed={!customDate && revisitDate === null}
              disabled={saving}
              onClick={() => {
                setCustomDate(false);
                setRevisitDate(null);
              }}
            >
              {strings.revisitShortcutLabels.noDate}
            </button>
            <button
              type="button"
              className="choice-chip"
              aria-pressed={customDate}
              disabled={saving}
              onClick={() => setCustomDate(true)}
            >
              {strings.due} …
            </button>
          </div>
          {customDate ? (
            <HumanDateInput
              id={`wait-revisit-${task.id}`}
              value={revisitDate ?? ""}
              onChange={(date) => setRevisitDate(date)}
              onValidityChange={setDateValid}
              disabled={saving}
            />
          ) : null}
          <CaptionHintSuggestions
            hints={revisitHints.map((hint) => {
              const date =
                formatExactLocalDate(hint.date, locale) ?? hint.date;
              return {
                key: hint.key,
                label: strings.titleHintFollowUp(date),
              };
            })}
            disabled={saving}
            onSelect={(key) => {
              const hint = revisitHints.find(
                (candidate) => candidate.key === key,
              );
              if (hint) {
                setRevisitDate(hint.date);
                setCustomDate(true);
              }
            }}
          />
        </div>

        {error ? (
          <div className="task-row-error" role="alert">
            <span>{strings.error}</span>
            <span className="text-muted">{error}</span>
          </div>
        ) : null}

        <div className="row">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {strings.cancel}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !waitingFor.trim() || !dateValid}
          >
            {strings.startWaitingConfirm}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
