import { useState } from "react";
import type { Project } from "@machbar/shared";
import { isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";

export function ProjectDeadlineSheet({ story, onClose, onSave, onFailure, onRefresh, refreshing = false, refreshError = null }: {
  story: Project;
  onClose: () => void;
  onFailure?: (cause: unknown) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshError?: string | null;
  onSave: (patch: { dueDate: string | null }) => Promise<void>;
}) {
  const strings = useStrings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState(story.dueDate ?? "");
  const [staleRevision, setStaleRevision] = useState<number | null>(null);
  const needsRefresh = staleRevision !== null && story.revision === staleRevision;
  const commit = async (date: string | null) => {
    if (saving || refreshing || needsRefresh) return;
    setSaving(true);
    setError(null);
    try { await onSave({ dueDate: date }); }
    catch (cause) {
      onFailure?.(cause);
      setError(localizedErrorMessage(cause, strings));
      if (isStaleWriteConflict(cause)) { setStaleRevision(story.revision); onRefresh?.(); }
    } finally { setSaving(false); }
  };
  return <BottomSheet title={strings.projectDeadlineTitle} onClose={() => { if (!saving) onClose(); }} labelledBy="project-deadline-title">
    <div className="stack">
      <p className="text-muted">{story.title}</p>
      <div className="field">
        <label htmlFor="story-due">{strings.due}</label>
        <HumanDateInput id="story-due" value={dueDate} onChange={(date) => { setDueDate(date ?? ""); void commit(date); }} disabled={saving || needsRefresh} />
      </div>
      {refreshError && needsRefresh ? <p role="alert">{refreshError}</p> : null}
      {error ? <><p role="alert" style={{ color: "var(--color-danger)" }}>{error}</p><button type="button" className="btn" disabled={saving || refreshing || (needsRefresh && !refreshError)} onClick={() => {
        if (needsRefresh) onRefresh?.();
        else void commit(dueDate || null);
      }}>{strings.retry}</button></> : null}
      <button type="button" className="btn" onClick={onClose} disabled={saving}>{strings.cancel}</button>
    </div>
  </BottomSheet>;
}
