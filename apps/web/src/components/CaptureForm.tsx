import { useState } from "react";
import type { ProjectWithActions, CreateTaskInput } from "../lib/api";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { strings } from "../lib/strings";
import { ownerAssignmentPatch } from "./TaskQuickActionSheet";
import { MarkdownEditor } from "./MarkdownEditor";

export type CaptureResult =
  | {
      kind: "task";
      task: Awaited<ReturnType<typeof api.createTask>>;
      needsClarification: boolean;
    }
  | {
      kind: "project";
      project: ProjectWithActions;
    };

export interface CaptureFormProps {
  initialTitle?: string;
  initialNotes?: string;
  projectId?: number | null;
  parentTaskId?: number | null;
  showNotes?: boolean;
  autoFocus?: boolean;
  onCancel: () => void;
  onCaptured: (result: CaptureResult) => void;
}

/** Shared Capture editor used by both the global FAB and incoming shares. */
export function CaptureForm({
  initialTitle = "",
  initialNotes = "",
  projectId,
  parentTaskId,
  showNotes = false,
  autoFocus = true,
  onCancel,
  onCaptured,
}: CaptureFormProps) {
  const [title, setTitle] = useState(initialTitle);
  const [notes, setNotes] = useState(initialNotes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { currentMemberId } = useIdentity();

  const taskInput = (needsClarification: boolean): CreateTaskInput => ({
    title: title.trim(),
    ...(notes ? { notes } : {}),
    projectId: projectId ?? null,
    parentTaskId: parentTaskId ?? null,
    createdByMemberId: currentMemberId,
    status: needsClarification ? "captured" : "actionable",
    dueDate: null,
    scheduledDate: null,
    ...(currentMemberId === null ? {} : ownerAssignmentPatch(currentMemberId)),
  });

  const createTask = async (needsClarification: boolean) => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const task = await api.createTask(taskInput(needsClarification));
      onCaptured({ kind: "task", task, needsClarification });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const createProject = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const project = await api.createProject({
        title: title.trim(),
        ...(notes ? { notes } : {}),
        status: currentMemberId === null ? "backlog" : "active",
        ownerMemberId: currentMemberId,
      });
      onCaptured({ kind: "project", project });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void createTask(true);
      }}
    >
      <div className="field">
        <label htmlFor="capture-title">{strings.titleEnough}</label>
        <input
          id="capture-title"
          autoFocus={autoFocus}
          value={title}
          placeholder={strings.quickAddPlaceholder}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      {showNotes || notes ? (
        <div className="field">
          <label htmlFor="capture-notes">{strings.notes}</label>
          <MarkdownEditor
            id="capture-notes"
            rows={5}
            value={notes}
            onChange={setNotes}
            toolbarLabel={strings.markdownToolbar}
          />
        </div>
      ) : null}
      {error ? <p className="capture-error" role="alert">{error}</p> : null}
      <div className="capture-shape-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {strings.cancel}
        </button>
        <button type="submit" className="btn" disabled={saving || !title.trim()}>
          {strings.clarifyLater}
        </button>
        <button
          type="button"
          className="btn btn-primary capture-shape-action"
          aria-label={strings.captureMachbar}
          disabled={saving || !title.trim()}
          onClick={() => void createTask(false)}
        >
          <span>{strings.captureMachbar}</span>
          <small>{strings.captureMachbarHint}</small>
        </button>
        <button
          type="button"
          className="btn btn-primary capture-shape-action"
          aria-label={strings.captureProject}
          disabled={saving || !title.trim()}
          onClick={() => void createProject()}
        >
          <span>{strings.captureProject}</span>
          <small>{strings.captureProjectHint}</small>
        </button>
      </div>
    </form>
  );
}
