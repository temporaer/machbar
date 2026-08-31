import { useState } from "react";
import type { ProjectWithActions, CreateTaskInput } from "../lib/api";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { ownerAssignmentPatch } from "../lib/useTaskActions";
import { MarkdownEditor } from "./MarkdownEditor";
import { HumanDateInput } from "./HumanDateInput";

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
  initialDueDate?: string | null;
  projectId?: number | null;
  parentTaskId?: number | null;
  showNotes?: boolean;
  showDueDate?: boolean;
  autoFocus?: boolean;
  onCancel: () => void;
  onCaptured: (result: CaptureResult) => void;
}

/** Shared Capture editor used by both the global FAB and incoming shares. */
export function CaptureForm({
  initialTitle = "",
  initialNotes = "",
  initialDueDate = null,
  projectId,
  parentTaskId,
  showNotes = false,
  showDueDate = false,
  autoFocus = true,
  onCancel,
  onCaptured,
}: CaptureFormProps) {
  const strings = useStrings();
  const [title, setTitle] = useState(initialTitle);
  const [notes, setNotes] = useState(initialNotes);
  const [dueDate, setDueDate] = useState<string | null>(initialDueDate);
  const [dueDateValid, setDueDateValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { currentMemberId } = useIdentity();
  const canDeferClassification =
    (projectId ?? null) === null && (parentTaskId ?? null) === null;

  const taskInput = (needsClarification: boolean): CreateTaskInput => ({
    title: title.trim(),
    ...(notes ? { notes } : {}),
    projectId: projectId ?? null,
    parentTaskId: parentTaskId ?? null,
    createdByMemberId: currentMemberId,
    status: needsClarification ? "captured" : "actionable",
    dueDate,
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
      setError(localizedErrorMessage(cause, strings));
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
        ...(showDueDate ? { dueDate } : {}),
      });
      onCaptured({ kind: "project", project });
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void createTask(canDeferClassification);
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
      {showDueDate ? (
        <div className="field">
          <label htmlFor="capture-due">{strings.due}</label>
          <HumanDateInput
            id="capture-due"
            value={dueDate}
            onChange={setDueDate}
            onValidityChange={setDueDateValid}
          />
        </div>
      ) : null}
      {error ? <p className="capture-error" role="alert">{error}</p> : null}
      <div className="capture-shape-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {strings.cancel}
        </button>
        {canDeferClassification ? (
          <button
            type="submit"
            className="btn"
            disabled={saving || !title.trim() || !dueDateValid}
          >
            {strings.clarifyLater}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary capture-shape-action"
          aria-label={strings.captureMachbar}
          disabled={saving || !title.trim() || !dueDateValid}
          onClick={() => void createTask(false)}
        >
          <span>{strings.captureMachbar}</span>
          <small>{strings.captureMachbarHint}</small>
        </button>
        <button
          type="button"
          className="btn btn-primary capture-shape-action"
          aria-label={strings.captureProject}
          disabled={saving || !title.trim() || !dueDateValid}
          onClick={() => void createProject()}
        >
          <span>{strings.captureProject}</span>
          <small>{strings.captureProjectHint}</small>
        </button>
      </div>
    </form>
  );
}
