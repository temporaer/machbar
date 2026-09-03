import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type {
  ProjectDetail,
  ProjectWithActions,
  ProjectWorkflowAction,
  UpdateProjectInput,
} from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import type { Strings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useProjectActions } from "../lib/useProjectActions";
import { AcceptanceCriteriaEditor } from "./AcceptanceCriteriaEditor";
import { BottomSheet } from "./BottomSheet";
import { TagPicker } from "./TagPicker";
import { MarkdownEditor } from "./MarkdownEditor";
import { HumanDateInput } from "./HumanDateInput";
import { MemberChoiceGroup } from "./MemberChoiceGroup";
import { QuickAdd } from "./QuickAdd";
import { isProjectReadyToStart } from "../lib/projectCommitments";
import { PhysicalContextPicker } from "./PhysicalContextPicker";

function errorMessage(err: unknown, strings: Strings): string {
  return localizedErrorMessage(err, strings);
}

export type ProjectEditFocusField = "driver" | "completion" | "notes";

/**
 * Mobile bottom-sheet editor for a project/story: metadata (title, driver,
 * tags, due/scheduled dates), the ordered acceptance-criteria list
 * (add/edit/reorder/check/remove — replacing any free-text description),
 * and the explicit lifecycle actions legal for the story's current status
 * (`project.availableActions`, computed by the backend). Title and notes are
 * independent, explicit edit transactions; all structured properties still
 * save immediately.
 *
 * The status itself is **never** a `<select>`: it is displayed as a
 * read-only badge, and it changes only through the labelled group of
 * thumb-sized transition buttons next to it — the same set of legal steps a
 * `ProjectStoryRow` offers via swipe/chips.
 */
export function ProjectEditSheet({
  project,
  onClose,
  onDeleted,
  onProjectConfirmed,
  focusField,
}: {
  project: ProjectDetail;
  onClose: () => void;
  onDeleted?: (() => void) | undefined;
  onProjectConfirmed?: ((project: ProjectWithActions) => void) | undefined;
  focusField?: ProjectEditFocusField | undefined;
}) {
  const strings = useStrings();
  const lifecycleLabels: Record<ProjectWorkflowAction, string> = {
    activate: strings.activateStory,
    return_to_backlog: strings.returnToBacklogStory,
    complete: strings.completeStory,
    reopen: strings.reopen,
    archive: strings.archiveStory,
  };
  const { members } = useIdentity();
  const { bump } = useRefresh();
  const navigate = useNavigate();
  const { data: tags } = useAsync(() => api.getTags(), []);
  const { data: homeAssistant } = useAsync(
    () =>
      typeof api.getHomeAssistantStatus === "function"
        ? api.getHomeAssistantStatus()
        : Promise.resolve(null),
    [],
  );
  const authoritativeProjects = useMemo(() => [project], [project]);
  const {
    isPending,
    retained,
    errors,
    clearError,
    runAction,
    update,
    assignDriver,
    schedule,
    setContexts,
  } = useProjectActions(authoritativeProjects);

  const [titleDraft, setTitleDraft] = useState(project.title);
  const [notesDraft, setNotesDraft] = useState(project.notes);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [savingField, setSavingField] = useState<"title" | "notes" | null>(null);
  const [savingProperty, setSavingProperty] = useState(false);
  const [busyAction, setBusyAction] = useState<ProjectWorkflowAction | null>(null);
  const [activationNeedsDriver, setActivationNeedsDriver] = useState(false);
  const [driverAction, setDriverAction] = useState<
    Extract<ProjectWorkflowAction, "activate" | "reopen">
  >("activate");
  const [activationNeedsProgress, setActivationNeedsProgress] = useState(false);
  const [addingNextAction, setAddingNextAction] = useState(false);
  const [completionNeedsCriteria, setCompletionNeedsCriteria] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const lastLoadedProjectIdRef = useRef<number | null>(null);
  const operationRef = useRef(false);
  const confirmedProjectRef = useRef<ProjectWithActions>(project);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const notesInputRef = useRef<HTMLTextAreaElement>(null);
  const notesFieldRef = useRef<HTMLDivElement>(null);
  const driverFieldRef = useRef<HTMLDivElement>(null);
  const lifecycleFieldRef = useRef<HTMLDivElement>(null);
  const criteriaFieldRef = useRef<HTMLDivElement>(null);
  const appliedFocusRef = useRef<string | null>(null);

  useEffect(() => {
    const isNewProject = lastLoadedProjectIdRef.current !== project.id;
    if (isNewProject) {
      confirmedProjectRef.current = project;
      setTitleDraft(project.title);
      setNotesDraft(project.notes);
      setEditingTitle(false);
      setEditingNotes(false);
    } else if (project.revision >= confirmedProjectRef.current.revision) {
      confirmedProjectRef.current = project;
      if (!editingTitle) setTitleDraft(project.title);
      if (!editingNotes) setNotesDraft(project.notes);
    }
    lastLoadedProjectIdRef.current = project.id;
  }, [editingNotes, editingTitle, project]);

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus();
  }, [editingTitle]);

  useEffect(() => {
    if (editingNotes) notesInputRef.current?.focus();
  }, [editingNotes]);

  useEffect(() => {
    const focusKey = focusField ? `${project.id}:${focusField}` : null;
    if (!focusField || appliedFocusRef.current === focusKey) return;
    if (focusField === "notes") {
      setNotesDraft(confirmedProjectRef.current.notes);
      setEditingNotes(true);
      notesFieldRef.current?.scrollIntoView?.({
        block: "center",
        behavior: "smooth",
      });
      appliedFocusRef.current = focusKey;
      return;
    }
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

  const retainedProject = retained.get(project.id)?.story;
  const displayedProject = retainedProject ?? project;
  const workflowError = errors[project.id] ?? null;
  const projectPending = isPending(project.id);
  const projectBusy =
    projectPending ||
    operationRef.current ||
    savingField !== null ||
    savingProperty ||
    busyAction !== null;

  const beginOperation = () => {
    if (operationRef.current) return false;
    operationRef.current = true;
    setActionError(null);
    clearError(project.id);
    return true;
  };

  const finishOperation = () => {
    operationRef.current = false;
  };

  const keepConfirmedProject = (confirmed: ProjectWithActions) => {
    confirmedProjectRef.current = confirmed;
    onProjectConfirmed?.(confirmed);
  };

  const saveTextField = async (field: "title" | "notes") => {
    const value = field === "title" ? titleDraft.trim() : notesDraft;
    if ((field === "title" && !value) || !beginOperation()) return;
    setSavingField(field);
    try {
      const confirmed = await update(
        confirmedProjectRef.current,
        { [field]: value },
        { [field]: value },
        true,
      );
      if (!confirmed) return;
      keepConfirmedProject(confirmed);
      if (field === "title") {
        setTitleDraft(confirmed.title);
        setEditingTitle(false);
      } else {
        setNotesDraft(confirmed.notes);
        setEditingNotes(false);
      }
    } catch {
      // The workflow hook owns localized mutation errors. Keep this draft open.
    } finally {
      setSavingField(null);
      finishOperation();
    }
  };

  const patch = async (
    input: UpdateProjectInput,
    kind: "driver" | "schedule" | "tags",
  ) => {
    if (!beginOperation()) return;
    setSavingProperty(true);
    try {
      const current = confirmedProjectRef.current;
      let confirmed: ProjectWithActions | undefined;
      if (kind === "driver") {
        confirmed = await assignDriver(current, input.ownerMemberId ?? null);
      } else if (kind === "schedule") {
        confirmed = await schedule(current, {
          ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
          ...(input.scheduledDate !== undefined
            ? { scheduledDate: input.scheduledDate }
            : {}),
        });
      } else {
        const tagIds = input.tagIds ?? [];
        confirmed = await update(
          current,
          { tagIds },
          { tags: (tags ?? current.tags).filter((tag) => tagIds.includes(tag.id)) },
          true,
        );
      }
      if (confirmed) keepConfirmedProject(confirmed);
    } catch {
      // The workflow hook owns localized mutation errors.
    } finally {
      setSavingProperty(false);
      finishOperation();
    }
  };

  const performAction = async (action: ProjectWorkflowAction) => {
    if (
      action === "complete" &&
      confirmedProjectRef.current.acceptanceCriteria.some((criterion) => !criterion.checked)
    ) {
      setCompletionNeedsCriteria(true);
      criteriaFieldRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      criteriaFieldRef.current?.querySelector<HTMLElement>("button, input")?.focus();
      return;
    }
    if (
      (action === "activate" || action === "reopen") &&
      confirmedProjectRef.current.ownerMemberId === null
    ) {
      setDriverAction(action);
      setActivationNeedsDriver(true);
      driverFieldRef.current?.scrollIntoView?.({
        block: "center",
        behavior: "smooth",
      });
      driverFieldRef.current
        ?.querySelector<HTMLElement>("button")
        ?.focus();
      return;
    }
    if (
      (action === "activate" || action === "reopen") &&
      !isProjectReadyToStart(confirmedProjectRef.current)
    ) {
      setActivationNeedsProgress(true);
      return;
    }
    setActivationNeedsDriver(false);
    setActivationNeedsProgress(false);
    setCompletionNeedsCriteria(false);
    if (!beginOperation()) return;
    setBusyAction(action);
    try {
      const confirmed = await runAction(confirmedProjectRef.current, action);
      if (confirmed) keepConfirmedProject(confirmed);
    } finally {
      setBusyAction(null);
      finishOperation();
    }
  };

  const chooseDriver = async (ownerMemberId: number | null) => {
    if (!activationNeedsDriver || ownerMemberId === null) {
      await patch({ ownerMemberId }, "driver");
      return;
    }
    if (!beginOperation()) return;
    setSavingProperty(true);
    try {
      const confirmed = await runAction(
        confirmedProjectRef.current,
        driverAction,
        ownerMemberId,
      );
      if (confirmed) {
        keepConfirmedProject(confirmed);
        setActivationNeedsDriver(false);
      }
    } finally {
      setSavingProperty(false);
      finishOperation();
    }
  };

  const cancelTextField = (field: "title" | "notes") => {
    clearError(project.id);
    setActionError(null);
    if (field === "title") {
      setTitleDraft(confirmedProjectRef.current.title);
      setEditingTitle(false);
    } else {
      setNotesDraft(confirmedProjectRef.current.notes);
      setEditingNotes(false);
    }
  };

  const closeSheet = () => {
    setTitleDraft(confirmedProjectRef.current.title);
    setNotesDraft(confirmedProjectRef.current.notes);
    setEditingTitle(false);
    setEditingNotes(false);
    onClose();
  };

  const removeProject = async () => {
    if (!window.confirm(strings.deleteProjectConfirm)) return;
    setDeleting(true);
    setActionError(null);
    try {
      await api.deleteProject(project.id);
      bump();
      if (onDeleted) {
        onDeleted();
      } else {
        onClose();
        navigate("/projects");
      }
    } catch (err) {
      setActionError(errorMessage(err, strings));
      setDeleting(false);
    }
  };

  return (
    <>
      <BottomSheet
        title={strings.editProject}
        onClose={closeSheet}
        labelledBy="project-edit-title"
      >
        <div className="stack">
        {actionError ?? workflowError ? (
          <p role="alert" style={{ color: "var(--color-danger)" }}>
            {actionError ?? workflowError}
          </p>
        ) : null}

        <div className="field" ref={notesFieldRef}>
          <label htmlFor="project-notes">{strings.notes}</label>
          <MarkdownEditor
            ref={notesInputRef}
            id="project-notes"
            value={notesDraft}
            onChange={setNotesDraft}
            disabled={!editingNotes || projectBusy}
            rows={4}
            toolbarLabel={strings.markdownToolbar}
          />
          <div className="row">
            {editingNotes ? (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  aria-label={`${strings.save}: ${strings.notes}`}
                  disabled={
                    projectBusy || notesDraft === confirmedProjectRef.current.notes
                  }
                  onClick={() => void saveTextField("notes")}
                >
                  {strings.save}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  aria-label={`${strings.cancel}: ${strings.notes}`}
                  disabled={projectBusy}
                  onClick={() => cancelTextField("notes")}
                >
                  {strings.cancel}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={`${strings.edit}: ${strings.notes}`}
                disabled={projectBusy}
                onClick={() => {
                  clearError(project.id);
                  setActionError(null);
                  setNotesDraft(confirmedProjectRef.current.notes);
                  setEditingNotes(true);
                }}
              >
                {strings.edit}
              </button>
            )}
          </div>
        </div>

        <div className="field">
          <label htmlFor="project-title">{strings.projectTitle}</label>
          <input
            ref={titleInputRef}
            id="project-title"
            value={titleDraft}
            readOnly={!editingTitle}
            disabled={projectBusy && editingTitle}
            onChange={(e) => setTitleDraft(e.target.value)}
          />
          <div className="row">
            {editingTitle ? (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  aria-label={`${strings.save}: ${strings.projectTitle}`}
                  disabled={
                    projectBusy ||
                    !titleDraft.trim() ||
                    titleDraft.trim() === confirmedProjectRef.current.title
                  }
                  onClick={() => void saveTextField("title")}
                >
                  {strings.save}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  aria-label={`${strings.cancel}: ${strings.projectTitle}`}
                  disabled={projectBusy}
                  onClick={() => cancelTextField("title")}
                >
                  {strings.cancel}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={`${strings.edit}: ${strings.projectTitle}`}
                disabled={projectBusy}
                onClick={() => {
                  clearError(project.id);
                  setActionError(null);
                  setTitleDraft(confirmedProjectRef.current.title);
                  setEditingTitle(true);
                }}
              >
                {strings.edit}
              </button>
            )}
          </div>
        </div>

        <div className="field">
          <span className="field-label" id="project-status-label">
            {strings.projectStatus}
          </span>
          <div>
            <span className="badge">{strings.projectStatusLabels[displayedProject.status]}</span>
          </div>
        </div>

        <div
          className="lifecycle-actions"
          role="group"
          aria-labelledby="project-status-label"
          ref={lifecycleFieldRef}
        >
          {displayedProject.availableActions.map((action) => (
            <button
              key={action}
              type="button"
              className={`btn btn-sm${action === "activate" ? " btn-primary" : ""}${
                action === "archive" ? " btn-ghost" : ""
              }`}
              data-workflow-action={action}
              disabled={projectBusy}
              onClick={() => void performAction(action)}
            >
              {lifecycleLabels[action]}
            </button>
          ))}
        </div>
        {displayedProject.availableActions.includes("activate") &&
        displayedProject.ownerMemberId === null ? (
          <p className="text-muted">{strings.assignDriverToActivateHint}</p>
        ) : null}
        {activationNeedsProgress ? (
          <div className="stack" role="alert">
            <p className="text-muted">{strings.activationProgressRequired}</p>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setAddingNextAction(true)}
            >
              {strings.addNextAction}
            </button>
          </div>
        ) : null}

        <div ref={driverFieldRef}>
          <MemberChoiceGroup
            label={strings.driver}
            idPrefix={`project-driver-${project.id}`}
            members={members}
            value={displayedProject.ownerMemberId}
            onChange={(ownerMemberId) => void chooseDriver(ownerMemberId)}
            unassignedLabel={strings.noDriver}
            disabled={projectBusy}
          />
        </div>

        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="project-due">{strings.due}</label>
            <HumanDateInput
              id="project-due"
              value={displayedProject.dueDate ?? ""}
              onChange={(dueDate) => void patch({ dueDate }, "schedule")}
              disabled={projectBusy}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="project-scheduled">{strings.scheduled}</label>
            <HumanDateInput
              id="project-scheduled"
              value={displayedProject.scheduledDate ?? ""}
              onChange={(scheduledDate) => void patch({ scheduledDate }, "schedule")}
              disabled={projectBusy}
            />
          </div>
        </div>

        <div className="field">
          <label>{strings.tags}</label>
          <fieldset
            disabled={projectBusy}
            style={{ border: 0, margin: 0, padding: 0 }}
          >
            <TagPicker
              tags={tags ?? []}
              selectedIds={displayedProject.tags.map((tag) => tag.id)}
              onChange={(tagIds) => patch({ tagIds }, "tags")}
            />
          </fieldset>
        </div>

        {displayedProject.contexts.length > 0 ||
        homeAssistant?.contexts.some((context) => context.active) ? (
          <div className="field">
            <label>{strings.physicalContexts}</label>
            <PhysicalContextPicker
              contexts={homeAssistant?.contexts ?? []}
              selected={displayedProject.contexts}
              disabled={projectBusy}
              onChange={(_mode, contextIds) => {
                if (!beginOperation()) return;
                setSavingProperty(true);
                void setContexts(confirmedProjectRef.current, contextIds)
                  .then((confirmed) => {
                    if (confirmed) keepConfirmedProject(confirmed);
                  })
                  .catch((cause: unknown) => {
                    setActionError(localizedErrorMessage(cause, strings));
                  })
                  .finally(() => {
                    setSavingProperty(false);
                    finishOperation();
                  });
              }}
            />
          </div>
        ) : null}

        <div ref={criteriaFieldRef}>
          {completionNeedsCriteria ? (
            <p className="capture-error" role="alert">
              {strings.completionCriteriaRequired}
            </p>
          ) : null}
          <AcceptanceCriteriaEditor
            projectId={project.id}
            criteria={displayedProject.acceptanceCriteria}
            onError={setActionError}
          />
        </div>

        <button
          type="button"
          className="btn btn-danger btn-block"
          disabled={deleting || projectBusy}
          onClick={() => void removeProject()}
        >
          {strings.deleteProject}
        </button>
        </div>
      </BottomSheet>
      {addingNextAction ? (
        <QuickAdd
          projectId={project.id}
          autoOpen
          onAutoOpenClose={() => {
            setAddingNextAction(false);
            setActivationNeedsProgress(false);
            bump();
          }}
        />
      ) : null}
    </>
  );
}
