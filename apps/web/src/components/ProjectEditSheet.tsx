import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { ProjectDetail, ProjectWorkflowAction } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { strings, projectStatusLabels } from "../lib/strings";
import { AcceptanceCriteriaEditor } from "./AcceptanceCriteriaEditor";
import { BottomSheet } from "./BottomSheet";
import { TagPicker } from "./TagPicker";
import { MarkdownEditor } from "./MarkdownEditor";
import { HumanDateInput } from "./HumanDateInput";
import { MemberChoiceGroup } from "./MemberChoiceGroup";

/** The subset of story fields edited as free-text drafts in this sheet. */
interface TextFieldsSnapshot {
  title: string;
  notes: string;
}

function textFieldsSnapshot(project: ProjectDetail): TextFieldsSnapshot {
  return { title: project.title, notes: project.notes };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const lifecycleLabels: Record<ProjectWorkflowAction, string> = {
  activate: strings.activateStory,
  return_to_backlog: strings.returnToBacklogStory,
  complete: strings.completeStory,
  reopen: strings.reopen,
  archive: strings.archiveStory,
};

export type ProjectEditFocusField = "driver" | "completion";

/**
 * Mobile bottom-sheet editor for a project/story: metadata (title, driver,
 * tags, due/scheduled dates), the ordered acceptance-criteria list
 * (add/edit/reorder/check/remove — replacing any free-text description),
 * and the explicit lifecycle actions legal for the story's current status
 * (`project.availableActions`, computed by the backend). Mirrors
 * `TaskDetailSheet`'s dirty-draft/baseline pattern for free-text fields so
 * unsaved edits are never silently lost or overwritten by a background
 * reload.
 *
 * The status itself is **never** a `<select>`: it is displayed as a
 * read-only badge, and it changes only through the labelled group of
 * thumb-sized transition buttons next to it — the same set of legal steps a
 * `ProjectStoryRow` offers via swipe/chips.
 */
export function ProjectEditSheet({
  project,
  onClose,
  focusField,
}: {
  project: ProjectDetail;
  onClose: () => void;
  focusField?: ProjectEditFocusField | undefined;
}) {
  const { members } = useIdentity();
  const { bump } = useRefresh();
  const navigate = useNavigate();
  const { data: tags } = useAsync(() => api.getTags(), []);

  const [titleDraft, setTitleDraft] = useState(project.title);
  const [notesDraft, setNotesDraft] = useState(project.notes);
  const [textFieldsBaseline, setTextFieldsBaseline] = useState<TextFieldsSnapshot>(textFieldsSnapshot(project));
  const [savingTextFields, setSavingTextFields] = useState(false);
  const [busyAction, setBusyAction] = useState<ProjectWorkflowAction | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dueDateValid, setDueDateValid] = useState(true);
  const [scheduledDateValid, setScheduledDateValid] = useState(true);
  const lastLoadedProjectIdRef = useRef<number | null>(null);
  const driverFieldRef = useRef<HTMLDivElement>(null);
  const lifecycleFieldRef = useRef<HTMLDivElement>(null);
  const appliedFocusRef = useRef<string | null>(null);

  // Resets drafts (and the dirty-check baseline) whenever a *different*
  // project is opened, or whenever fresh data arrives and the user has no
  // unsaved edits — a background reload triggered mid-edit (e.g. another
  // patch, or an unrelated refresh elsewhere) must never clobber in-progress
  // typing, so it is skipped whenever the drafts still differ from the last
  // known-saved baseline.
  useEffect(() => {
    const nextBaseline = textFieldsSnapshot(project);
    const isNewProject = lastLoadedProjectIdRef.current !== project.id;
    const hasUnsavedEdits =
      !isNewProject &&
      (titleDraft !== textFieldsBaseline.title ||
        notesDraft !== textFieldsBaseline.notes);
    if (!hasUnsavedEdits) {
      setTitleDraft(nextBaseline.title);
      setNotesDraft(nextBaseline.notes);
      setTextFieldsBaseline(nextBaseline);
    }
    lastLoadedProjectIdRef.current = project.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  useEffect(() => {
    const focusKey = focusField ? `${project.id}:${focusField}` : null;
    if (!focusField || appliedFocusRef.current === focusKey) return;
    const container =
      focusField === "driver"
        ? driverFieldRef.current
        : lifecycleFieldRef.current;
    if (!container) return;
    container.scrollIntoView?.({ block: "center", behavior: "smooth" });
    const focusable =
      focusField === "completion"
        ? container.querySelector<HTMLElement>('[data-workflow-action="complete"]')
        : (container.querySelector<HTMLElement>('button[aria-pressed="true"]') ??
          container.querySelector<HTMLElement>("button"));
    focusable?.focus();
    appliedFocusRef.current = focusKey;
  }, [focusField, project.id]);

  const titleIsValid = titleDraft.trim().length > 0;
  const textFieldsDirty =
    titleDraft !== textFieldsBaseline.title ||
    notesDraft !== textFieldsBaseline.notes;
  const saveChangesDisabled = !textFieldsDirty || !titleIsValid || savingTextFields;

  const saveTextFields = async () => {
    if (!titleIsValid) return;
    const snapshot: TextFieldsSnapshot = {
      title: titleDraft.trim(),
      notes: notesDraft,
    };
    setSavingTextFields(true);
    setActionError(null);
    try {
      await api.updateProject(project.id, {
        title: snapshot.title,
        notes: snapshot.notes,
      });
      // Adopt the just-saved values as the new baseline right away so the
      // save button disables immediately, without waiting for the parent's
      // reload round trip (which may race with further typing).
      setTextFieldsBaseline(snapshot);
      bump();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSavingTextFields(false);
    }
  };

  const patch = async (input: Parameters<typeof api.updateProject>[1]) => {
    setActionError(null);
    try {
      await api.updateProject(project.id, input);
      bump();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const runAction = async (action: ProjectWorkflowAction) => {
    setBusyAction(action);
    setActionError(null);
    try {
      switch (action) {
        case "activate":
          await api.activateProject(project.id);
          break;
        case "return_to_backlog":
          await api.returnProjectToBacklog(project.id);
          break;
        case "complete":
          await api.completeProject(project.id);
          break;
        case "reopen":
          await api.reopenProject(project.id);
          break;
        case "archive":
          await api.archiveProject(project.id);
          break;
      }
      bump();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  };

  const removeProject = async () => {
    if (!window.confirm(strings.deleteProjectConfirm)) return;
    setDeleting(true);
    setActionError(null);
    try {
      await api.deleteProject(project.id);
      onClose();
      bump();
      navigate("/projekte");
    } catch (err) {
      setActionError(errorMessage(err));
      setDeleting(false);
    }
  };

  return (
    <BottomSheet
      title={strings.editProject}
      onClose={() => {
        if (dueDateValid && scheduledDateValid) onClose();
      }}
      labelledBy="project-edit-title"
    >
      <div className="stack">
        {actionError ? (
          <p role="alert" style={{ color: "var(--color-danger)" }}>
            {actionError}
          </p>
        ) : null}

        <div className="field">
          <label htmlFor="project-notes">{strings.notes}</label>
          <MarkdownEditor
            id="project-notes"
            value={notesDraft}
            onChange={setNotesDraft}
            onBlur={() => void saveTextFields()}
            rows={4}
            toolbarLabel={strings.markdownToolbar}
          />
        </div>

        <div className="field">
          <label htmlFor="project-title">{strings.projectTitle}</label>
          <input
            id="project-title"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void saveTextFields()}
          />
        </div>

        <div className="field">
          <span className="field-label" id="project-status-label">
            {strings.projectStatus}
          </span>
          <div>
            <span className="badge">{projectStatusLabels[project.status]}</span>
          </div>
        </div>

        <div
          className="lifecycle-actions"
          role="group"
          aria-labelledby="project-status-label"
          ref={lifecycleFieldRef}
        >
          {project.availableActions.map((action) => (
            <button
              key={action}
              type="button"
              className={`btn btn-sm${action === "activate" ? " btn-primary" : ""}${
                action === "archive" ? " btn-ghost" : ""
              }`}
              data-workflow-action={action}
              disabled={busyAction !== null}
              onClick={() => void runAction(action)}
            >
              {lifecycleLabels[action]}
            </button>
          ))}
        </div>
        {project.availableActions.includes("activate") && project.ownerMemberId === null ? (
          <p className="text-muted">{strings.assignDriverToActivateHint}</p>
        ) : null}

        <div ref={driverFieldRef}>
          <MemberChoiceGroup
            label={strings.driver}
            idPrefix={`project-driver-${project.id}`}
            members={members}
            value={project.ownerMemberId}
            onChange={(ownerMemberId) => void patch({ ownerMemberId })}
            unassignedLabel={strings.noDriver}
          />
        </div>

        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="project-due">{strings.due}</label>
            <HumanDateInput
              id="project-due"
              value={project.dueDate ?? ""}
              onChange={(dueDate) => void patch({ dueDate })}
              onValidityChange={setDueDateValid}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="project-scheduled">{strings.scheduled}</label>
            <HumanDateInput
              id="project-scheduled"
              value={project.scheduledDate ?? ""}
              onChange={(scheduledDate) => void patch({ scheduledDate })}
              onValidityChange={setScheduledDateValid}
            />
          </div>
        </div>

        <div className="field">
          <label>{strings.tags}</label>
          <TagPicker
            tags={tags ?? []}
            selectedIds={project.tags.map((tag) => tag.id)}
            onChange={(tagIds) => patch({ tagIds })}
          />
        </div>

        <button
          type="button"
          className={`btn btn-block${saveChangesDisabled ? "" : " btn-primary"}`}
          disabled={saveChangesDisabled}
          onClick={() => void saveTextFields()}
        >
          {strings.saveChanges}
        </button>

        <AcceptanceCriteriaEditor
          projectId={project.id}
          criteria={project.acceptanceCriteria}
          onError={setActionError}
        />

        <button
          type="button"
          className="btn btn-danger btn-block"
          disabled={deleting || busyAction !== null}
          onClick={() => void removeProject()}
        >
          {strings.deleteProject}
        </button>
      </div>
    </BottomSheet>
  );
}
