import { useEffect, useRef, useState } from "react";
import type { CreateTaskStepBatchInput } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { IconActionButton } from "./IconActionButton";

export type StepDraft = CreateTaskStepBatchInput["steps"][number];

/** Shared authored step entry for task splitting, inline successors, and the
 * project task entry. The caller owns the canonical mutation. */
export function StepComposer({
  inputIdPrefix,
  label,
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  onDraftChange,
  onPendingChange,
  singleStep = false,
  submitDisabled = false,
  draftKey,
}: {
  inputIdPrefix: string;
  label: string;
  placeholder: string;
  submitLabel: string | ((count: number) => string);
  draftKey?: string;
  onSubmit: (steps: StepDraft[]) => Promise<void | boolean>;
  onCancel?: () => void;
  onDraftChange?: (steps: StepDraft[]) => void;
  onPendingChange?: (pending: boolean) => void;
  singleStep?: boolean;
  submitDisabled?: boolean;
}) {
  const strings = useStrings();
  const [rows, setRows] = useState<StepDraft[]>(() => {
    if (draftKey) {
      try { const rows: unknown = JSON.parse(sessionStorage.getItem(`machbar:steps:${draftKey}`) ?? "null");
        if (Array.isArray(rows) && rows.length && rows.every(row => typeof row.title === "string" && (row.dueDate === undefined || typeof row.dueDate === "string") && (row.scheduledDate === undefined || typeof row.scheduledDate === "string"))) return rows;
      } catch { /* Empty draft when browser storage is unavailable. */ }
    }
    return [blankStep()];
  });
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const steps = rows.filter((row) => row.title.trim() !== "").map((row) => ({
    title: row.title.trim(),
    ...(row.dueDate ? { dueDate: row.dueDate } : {}),
    ...(row.scheduledDate ? { scheduledDate: row.scheduledDate } : {}),
  }));

  function blankStep(): StepDraft {
    return { title: "" };
  }

  const changeRows = (next: StepDraft[]) => {
    if (draftKey) {
      try {
        if (next.some(row => row.title.trim() || row.dueDate || row.scheduledDate)) sessionStorage.setItem(`machbar:steps:${draftKey}`, JSON.stringify(next));
        else sessionStorage.removeItem(`machbar:steps:${draftKey}`);
      } catch { /* The live draft remains available during this session. */ }
    }
    setRows(next);
    onDraftChange?.(next.filter((row) => row.title.trim() !== "").map((row) => ({
      title: row.title.trim(),
      ...(row.dueDate ? { dueDate: row.dueDate } : {}),
      ...(row.scheduledDate ? { scheduledDate: row.scheduledDate } : {}),
    })));
  };

  useEffect(() => { onDraftChange?.(steps); }, []);

  const changeField = (index: number, field: keyof StepDraft, value: string) => {
    const next = rows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row);
    if (!singleStep && index === rows.length - 1 && field === "title" && value.trim() !== "") next.push(blankStep());
    changeRows(next);
  };

  const removeRow = (index: number) => {
    const next = rows.filter((_, rowIndex) => rowIndex !== index);
    changeRows(next.length === 0 ? [blankStep()] : next);
    requestAnimationFrame(() => inputRefs.current[Math.max(0, index - 1)]?.focus());
  };

  const submit = async () => {
    if (savingRef.current || steps.length === 0) return;
    savingRef.current = true;
    setSaving(true);
    onPendingChange?.(true);
    setError(null);
    try {
      const saved = await onSubmit(steps);
      if (saved !== false) changeRows([blankStep()]);
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      savingRef.current = false;
      setSaving(false);
      onPendingChange?.(false);
    }
  };

  return (
    <form
      className="stack step-composer"
      aria-label={label}
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {rows.map((row, index) => (
        <div className="stack step-composer-row" key={index}>
          <div className="row">
            <label htmlFor={`${inputIdPrefix}-${index}`} className="sr-only">{label}</label>
            <input
              id={`${inputIdPrefix}-${index}`}
              ref={(element) => { inputRefs.current[index] = element; }}
              autoFocus={index === 0}
              value={row.title}
              placeholder={placeholder}
              disabled={saving}
              onChange={(event) => changeField(index, "title", event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !singleStep) {
                  event.preventDefault();
                  if (row.title.trim() !== "" && index === rows.length - 1) {
                    changeRows([...rows, blankStep()]);
                    requestAnimationFrame(() => inputRefs.current[index + 1]?.focus());
                  } else if (index < rows.length - 1) {
                    requestAnimationFrame(() => inputRefs.current[index + 1]?.focus());
                  }
                } else if (event.key === "Backspace" && row.title === "" && rows.length > 1) {
                  event.preventDefault();
                  removeRow(index);
                } else if (event.key === "Escape" && !savingRef.current && singleStep) {
                  event.preventDefault();
                  event.stopPropagation();
                  onCancel?.();
                }
              }}
            />
            {!singleStep && row.title.trim() !== "" ? (
              <IconActionButton kind="close" label={strings.removeStep} onClick={() => removeRow(index)} />
            ) : null}
          </div>
          {row.title.trim() !== "" ? (
            <details className="step-composer-planning">
              <summary>{strings.stepPlanningOptional}</summary>
              <div className="row">
                <label>{strings.scheduled}<input type="date" value={row.scheduledDate ?? ""} disabled={saving}
                  onChange={(event) => changeField(index, "scheduledDate", event.target.value)} /></label>
                <label>{strings.due}<input type="date" value={row.dueDate ?? ""} disabled={saving}
                  onChange={(event) => changeField(index, "dueDate", event.target.value)} /></label>
              </div>
            </details>
          ) : null}
        </div>
      ))}
      {error ? <div className="task-row-error" role="alert"><span>{strings.error}</span><span className="text-muted">{error}</span></div> : null}
      <div className="row">
        {onCancel ? <button type="button" className="btn" disabled={saving} onClick={onCancel}>{strings.cancel}</button> : null}
        <button type="submit" className="btn btn-primary" disabled={saving || steps.length === 0 || submitDisabled}>
          {saving ? strings.saving : typeof submitLabel === "function" ? submitLabel(steps.length) : submitLabel}
        </button>
      </div>
    </form>
  );
}
