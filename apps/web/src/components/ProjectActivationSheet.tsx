import { useState } from "react";
import type { ProjectDetail, ProjectWorkflowAction } from "../lib/api";
import { isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

export function ProjectActivationSheet({
  story, loading, action, readError, requirementsChanged, onRetry,
  onRequirementsChanged, isCurrent, onClose, onActivationSuccess, onActivate,
}: {
  story: ProjectDetail | null;
  loading: boolean;
  action: Extract<ProjectWorkflowAction, "activate" | "reopen">;
  readError: string | null;
  requirementsChanged: boolean;
  onRetry: () => void;
  onRequirementsChanged: () => void;
  isCurrent: () => boolean;
  onClose: () => void;
  onActivationSuccess: () => void;
  onActivate: (ownerMemberId: number | null, nextActionTitle?: string, expectedRevision?: number) => Promise<void>;
}) {
  const strings = useStrings();
  const { members } = useIdentity();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [driver, setDriver] = useState<number | null>(null);
  const [nextActionTitle, setNextActionTitle] = useState("");
  const required = story?.activationReadiness.requiredDecisions ?? [];
  const needsDriver = required.includes("driver");
  const needsPath = required.includes("progressPath");
  const ready = !!story && (!needsDriver || driver !== null) && (!needsPath || !!nextActionTitle.trim());

  const submit = async () => {
    if (saving || !story || !ready || readError || loading) return;
    setSaving(true);
    setError(null);
    try {
      await onActivate(needsDriver ? driver : story.ownerMemberId, needsPath ? nextActionTitle.trim() : undefined, story.revision);
      if (isCurrent()) onActivationSuccess();
    } catch (cause) {
      if (!isCurrent()) return;
      if (isStaleWriteConflict(cause)) onRequirementsChanged();
      else setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return <BottomSheet title={action === "reopen" ? strings.reopen : strings.activateStory} onClose={() => { if (!saving) onClose(); }}>
    <div className="stack">
      {story ? <>
        <p className="text-muted">{story.title}</p>
        {requirementsChanged ? <p role="alert" className="task-row-error">{strings.activationRequirementsChanged}</p> : null}
        {needsDriver ? <div className="field">
          <label htmlFor="activation-driver">{strings.commitmentDriverFor(story.title)}</label>
          <select id="activation-driver" value={driver ?? ""} disabled={saving} onChange={(event) => setDriver(event.target.value ? Number(event.target.value) : null)}>
            <option value="">{strings.noDriver}</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
        </div> : null}
        {needsPath ? <div className="field">
          <label htmlFor="activation-next-action">{strings.commitmentNextActionLabel}</label>
          <input id="activation-next-action" value={nextActionTitle} onChange={(event) => setNextActionTitle(event.target.value)} disabled={saving} required />
        </div> : null}
        {readError ? <><p role="alert" className="task-row-error">{readError}</p><button type="button" className="btn" onClick={onRetry}>{strings.retry}</button></> : null}
        {error ? <p role="alert" className="task-row-error">{error}</p> : null}
      </> : loading ? <p role="status">{strings.loading}</p> : null}
      <div className="row">
        <button type="button" className="btn" disabled={saving} onClick={onClose}>{strings.cancel}</button>
        <button type="button" className="btn btn-primary" disabled={saving || !ready || !!readError || loading} onClick={() => void submit()}>
          {saving ? strings.saving : action === "reopen" ? strings.reopen : strings.activateStory}
        </button>
      </div>
    </div>
  </BottomSheet>;
}
