import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { InheritanceMode, Task } from "@machbar/shared";
import { inheritanceModes, taskStatuses } from "@machbar/shared";
import { api } from "../lib/api";
import type { ProjectWithActions } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { useTaskActions } from "../lib/useTaskActions";
import { useTaskDetail } from "../lib/taskDetailContext";
import type { TaskDetailFocusField } from "../lib/taskDetailContext";
import { useStrings } from "../lib/strings";
import { formatDateTime } from "../lib/format";
import { formatExactLocalDate } from "../lib/relativeDate";
import { sortByPosition } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";
import { LoadingState, ErrorState } from "./AsyncStates";
import { StatusBadge } from "./StatusBadge";
import { TagChip } from "./TagChip";
import { TagPicker } from "./TagPicker";
import { ChildPolicyPrompt } from "./ChildPolicyPrompt";
import { InlineChildComposer } from "./InlineChildComposer";
import { CapturedProjectHandoff } from "./CapturedProjectHandoff";
import { MoveTaskSheet } from "./MoveTaskSheet";
import type { MoveMode } from "./MoveTaskSheet";
import { ScheduleShortcuts } from "./ScheduleShortcuts";
import { MemberChoiceGroup } from "./MemberChoiceGroup";
import { MemberLabel } from "./MemberAvatar";
import { MarkdownEditor } from "./MarkdownEditor";
import { MarkdownNotes } from "./MarkdownNotes";
import { NativeShareButton } from "./NativeShareButton";
import { CalendarExportButton } from "./CalendarExportButton";
import { IconActionButton } from "./IconActionButton";
import { serializeTaskForShare } from "../lib/shareText";
import { buildTaskShareUrl } from "../lib/shareUrls";
import { HumanDateInput } from "./HumanDateInput";
import { RecentActivity } from "./RecentActivity";
import { useLocale } from "../lib/locale";
import {
  hasApiErrorCode,
  isStaleWriteConflict,
  localizedErrorMessage,
} from "../lib/errorMessage";
import {
  sortDependencies,
  sortDependencyCandidates,
} from "../lib/sortOrder";

/** The subset of task fields edited as free-text drafts in this sheet. */
interface TextFieldsSnapshot {
  title: string;
  notes: string;
}

function textFieldsSnapshot(task: Task): TextFieldsSnapshot {
  return {
    title: task.title,
    notes: task.notes ?? "",
  };
}

function InheritanceControl({
  mode,
  onChange,
  focusRef,
}: {
  mode: InheritanceMode;
  onChange: (mode: InheritanceMode) => void;
  focusRef?: RefObject<HTMLButtonElement>;
}) {
  const strings = useStrings();
  const labels: Record<InheritanceMode, string> = {
    inherit: strings.ownerInheritanceParent,
    explicit: strings.ownerInheritanceTaskSpecific,
    none: strings.ownerInheritanceNone,
  };
  return (
    <div className="segmented" role="group">
      {inheritanceModes.map((m) => (
        <button
          key={m}
          ref={m === inheritanceModes[0] ? focusRef : undefined}
          type="button"
          aria-pressed={mode === m}
          onClick={() => onChange(m)}
        >
          {labels[m]}
        </button>
      ))}
    </div>
  );
}

function TaskDetailSection({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section
      className={`task-detail-section${className ? ` ${className}` : ""}`}
      aria-labelledby={headingId}
    >
      <h3 id={headingId} className="task-detail-section-title">
        {title}
      </h3>
      <div className="task-detail-section-body">{children}</div>
    </section>
  );
}

function TaskDetailDisclosure({
  title,
  children,
  defaultOpen = false,
  resetKey,
  className = "",
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  resetKey: number;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen, resetKey]);

  return (
    <details
      className={`task-detail-section task-detail-disclosure${className ? ` ${className}` : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="task-detail-section-title disclosure-summary">
        <span role="heading" aria-level={3}>
          {title}
        </span>
      </summary>
      <div className="task-detail-section-body">{children}</div>
    </details>
  );
}

/**
 * Full-metadata editor for a single task, opened as a bottom sheet from any
 * list (Today, Inbox, project outline, search, waiting). Every field on the
 * shared `Task` contract is represented, including inheritance modes, tag
 * exclusion, dependencies, subtasks and the explicit refile/move actions
 * (`Sortier-Werkzeuge`), which is how compiled views — where the outline's
 * drag editing is deliberately unavailable — still reach them.
 */
export function TaskDetailSheet() {
  const strings = useStrings();
  const { locale } = useLocale();
  const { openTaskId, queueActive, focusField, clearFocusField, open, advanceQueue, close } = useTaskDetail();
  const { bump } = useRefresh();
  const { members } = useIdentity();
  const taskActions = useTaskActions();
  const [movePrompt, setMovePrompt] = useState<MoveMode | null>(null);
  const [depQuery, setDepQuery] = useState("");
  const [depResults, setDepResults] = useState<Task[]>([]);
  const [dependencyError, setDependencyError] = useState<{
    candidateTaskId: number | null;
    message: string;
  } | null>(null);
  const [addingDependencyId, setAddingDependencyId] = useState<number | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [externalWaitDraft, setExternalWaitDraft] = useState("");
  const [externalWaitDateDraft, setExternalWaitDateDraft] = useState("");
  const [externalWaitDateValid, setExternalWaitDateValid] = useState(true);
  const [textFieldsBaseline, setTextFieldsBaseline] = useState<TextFieldsSnapshot | null>(null);
  const [savingTextFields, setSavingTextFields] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [notesEditing, setNotesEditing] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [dueDateValid, setDueDateValid] = useState(true);
  const [scheduledDateValid, setScheduledDateValid] = useState(true);
  const [statusDraft, setStatusDraft] = useState<Task["status"]>("actionable");
  const [changingStatus, setChangingStatus] = useState(false);
  const [classificationBusy, setClassificationBusy] = useState(false);
  const [promotedProject, setPromotedProject] =
    useState<ProjectWithActions | null>(null);
  const titleFieldRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const ownerFieldRef = useRef<HTMLDivElement>(null);
  const ownerInputRef = useRef<HTMLButtonElement>(null);
  const scheduleFieldRef = useRef<HTMLDivElement>(null);
  const scheduleInputRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const dependenciesFieldRef = useRef<HTMLDivElement>(null);
  const dependencyInputRef = useRef<HTMLInputElement>(null);
  const subtasksFieldRef = useRef<HTMLDivElement>(null);
  const lastLoadedTaskIdRef = useRef<number | null>(null);
  const revisionRef = useRef<number | null>(null);

  const {
    data: loadedTask,
    loading,
    error,
    reload,
  } = useAsync(() => (openTaskId ? api.getTask(openTaskId) : Promise.resolve(null)), [openTaskId]);
  const task = loadedTask
    ? (taskActions.retained.get(loadedTask.id) ?? loadedTask)
    : null;
  const {
    data: recurrenceHistory,
    loading: recurrenceHistoryLoading,
    error: recurrenceHistoryError,
    reload: reloadRecurrenceHistory,
  } = useAsync(
    () =>
      openTaskId
        ? typeof api.getTaskRecurrenceHistory === "function"
          ? api.getTaskRecurrenceHistory(openTaskId)
          : Promise.resolve({
              summary: {
                hitCount: 0,
                missCount: 0,
                totalCount: 0,
                hitRate: null,
              },
              occurrences: [],
            })
        : Promise.resolve(null),
    [openTaskId, task?.revision],
  );
  const { data: tags } = useAsync(() => api.getTags(), []);

  // Resets the drafts (and the dirty-check baseline) whenever a *different*
  // task is opened, or whenever this task's data arrives from the server and
  // the user has no unsaved edits. A background reload triggered while the
  // user is mid-edit (e.g. another patch on this task, or an unrelated
  // refresh elsewhere in the app) must never clobber in-progress typing, so
  // it is skipped whenever the current drafts still differ from the last
  // known-saved baseline.
  useEffect(() => {
    if (!loadedTask) {
      lastLoadedTaskIdRef.current = null;
      setTextFieldsBaseline(null);
      return;
    }
    revisionRef.current = loadedTask.revision;
    const nextBaseline = textFieldsSnapshot(loadedTask);
    const isNewTask = lastLoadedTaskIdRef.current !== loadedTask.id;
    if (isNewTask) {
      setSaveError(null);
      setTitleEditing(false);
      setNotesEditing(false);
      setAddingChild(false);
      setDeleting(false);
      setShareStatus(null);
      setDueDateValid(true);
      setScheduledDateValid(true);
      setExternalWaitDateValid(true);
      setStatusDraft(loadedTask.status);
      setExternalWaitDraft(loadedTask.externalWait?.waitingFor ?? "");
      setExternalWaitDateDraft(
        loadedTask.externalWait ? loadedTask.scheduledDate ?? "" : "",
      );
      setDependencyError(null);
      setAddingDependencyId(null);
    }
    const hasUnsavedEdits =
      !isNewTask &&
      textFieldsBaseline !== null &&
      (titleDraft !== textFieldsBaseline.title ||
        notesDraft !== textFieldsBaseline.notes);

    if (hasUnsavedEdits && textFieldsBaseline !== null) {
      const previousBaseline = textFieldsBaseline;
      setTitleDraft((current) =>
        current === previousBaseline.title ? nextBaseline.title : current,
      );
      setNotesDraft((current) =>
        current === previousBaseline.notes ? nextBaseline.notes : current,
      );
      setTextFieldsBaseline(nextBaseline);
    } else {
      setTitleDraft(nextBaseline.title);
      setNotesDraft(nextBaseline.notes);
      setTextFieldsBaseline(nextBaseline);
    }
    lastLoadedTaskIdRef.current = loadedTask.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedTask]);

  useEffect(() => {
    if (task) setStatusDraft(task.status);
  }, [task?.id, task?.status, task?.revision]);

  useEffect(() => {
    if (!task || taskActions.errors[task.id] === undefined) return;
    setStatusDraft(task.status);
  }, [task, taskActions.errors]);

  // Chip-driven opens (Zuweisen/Planen/Notizen) land the user directly on the
  // relevant field of this same edit flow instead of just the sheet's top.
  useEffect(() => {
    if (!task || !focusField) return;
    if (focusField === "title" && !titleEditing) {
      setTitleEditing(true);
      return;
    }
    if (focusField === "notes" && !notesEditing) {
      setNotesEditing(true);
      return;
    }
    const scrollTargets: Record<TaskDetailFocusField, HTMLElement | null> = {
      title: titleFieldRef.current,
      owner: ownerFieldRef.current,
      schedule: scheduleFieldRef.current,
      notes: notesRef.current,
      dependencies: dependenciesFieldRef.current,
      subtasks: subtasksFieldRef.current,
    };
    const focusTargets: Record<TaskDetailFocusField, HTMLElement | null> = {
      title: titleInputRef.current,
      owner: ownerInputRef.current,
      schedule: scheduleInputRef.current,
      notes: notesRef.current,
      dependencies: dependencyInputRef.current,
      subtasks: null,
    };
    const scrollTarget = scrollTargets[focusField];
    const focusTarget = focusTargets[focusField];
    if (scrollTarget) {
      if (typeof scrollTarget.scrollIntoView === "function") {
        scrollTarget.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      focusTarget?.focus();
    }
    clearFocusField();
  }, [task, focusField, clearFocusField, notesEditing, titleEditing]);

  const inheritedTags = useMemo(() => {
    if (!task) return [];
    const explicitIds = new Set(task.explicitTags.map((t) => t.id));
    return task.effectiveTags.filter((t) => !explicitIds.has(t.id));
  }, [task]);

  if (openTaskId === null) return null;

  const patch = async (input: Parameters<typeof api.updateTask>[1]) => {
    if (!task) return;
    setSaveError(null);
    try {
      const updated = await taskActions.update(task, input, input, true);
      if (!updated) return;
      revisionRef.current = updated.revision;
    } catch (err) {
      if (isStaleWriteConflict(err)) reload();
      setSaveError(localizedErrorMessage(err, strings));
    }
  };

  const titleIsValid = titleDraft.trim().length > 0;
  const titleDirty =
    textFieldsBaseline !== null && titleDraft !== textFieldsBaseline.title;
  const notesDirty =
    textFieldsBaseline !== null && notesDraft !== textFieldsBaseline.notes;
  const contentDirty = titleDirty || notesDirty;

  const saveContentField = async (
    field: "title" | "notes",
  ): Promise<boolean> => {
    if (!task || savingTextFields) return false;
    const value = field === "title" ? titleDraft.trim() : notesDraft;
    if (field === "title" && !value) return false;
    const dirty = field === "title" ? titleDirty : notesDirty;
    if (!dirty) return true;
    setSavingTextFields(true);
    setSaveError(null);
    try {
      const updated = await taskActions.update(
        task,
        { [field]: value },
        { [field]: value },
        true,
      );
      if (!updated) return false;
      revisionRef.current = updated.revision;
      setTextFieldsBaseline((current) =>
        current ? { ...current, [field]: value } : current,
      );
      return true;
    } catch (err) {
      if (isStaleWriteConflict(err)) reload();
      setSaveError(localizedErrorMessage(err, strings));
      return false;
    } finally {
      setSavingTextFields(false);
    }
  };

  const cancelTitleEdit = () => {
    setTitleDraft(textFieldsBaseline?.title ?? task?.title ?? "");
    setTitleEditing(false);
  };

  const cancelNotesEdit = () => {
    setNotesDraft(textFieldsBaseline?.notes ?? task?.notes ?? "");
    setNotesEditing(false);
  };

  const finishClassification = () => {
    if (queueActive) {
      advanceQueue();
    } else {
      close();
    }
  };

  const classifyCapture = async (status: "actionable" | "someday") => {
    if (!task || classificationBusy || contentDirty) return;
    setClassificationBusy(true);
    setSaveError(null);
    try {
      const updated =
        status === "actionable"
          ? await taskActions.clarify(task)
          : await taskActions.setStatus(task, "someday");
      if (!updated) return;
      finishClassification();
    } catch (err) {
      if (isStaleWriteConflict(err)) {
        bump();
        reload();
      }
      setSaveError(localizedErrorMessage(err, strings));
    } finally {
      setClassificationBusy(false);
    }
  };

  const promoteCapture = async (openHandoff: boolean) => {
    if (!task || classificationBusy || contentDirty) return;
    setClassificationBusy(true);
    setSaveError(null);
    try {
      const project = await api.promoteTaskToProject(task.id, {
        status: "backlog",
        expectedRevision: revisionRef.current ?? task.revision,
      });
      bump();
      if (openHandoff) {
        setPromotedProject(project);
      } else {
        finishClassification();
      }
    } catch (err) {
      if (isStaleWriteConflict(err)) {
        bump();
        reload();
      }
      setSaveError(localizedErrorMessage(err, strings));
    } finally {
      setClassificationBusy(false);
    }
  };

  const changeStatus = async (nextStatus: Task["status"]) => {
    if (!task || nextStatus === statusDraft || changingStatus) return;
    const previousStatus = statusDraft;
    setSaveError(null);
    setStatusDraft(nextStatus);
    if (previousStatus === "done" || previousStatus === "cancelled") {
      setChangingStatus(true);
      try {
        const updated = await taskActions.transitionStatus(task, nextStatus);
        if (!updated) setStatusDraft(previousStatus);
      } catch (err) {
        setStatusDraft(previousStatus);
        setSaveError(localizedErrorMessage(err, strings));
      } finally {
        setChangingStatus(false);
      }
      return;
    }
    if (nextStatus === "done") {
      taskActions.requestToggle(task);
      if (task.repeatAfterDays !== null) setStatusDraft("actionable");
      return;
    }
    if (nextStatus === "cancelled") {
      taskActions.requestCancel(task);
      return;
    }
    setChangingStatus(true);
    try {
      const updated =
        nextStatus === "captured"
          ? await taskActions.update(
              task,
              { status: nextStatus },
              {
                status: nextStatus,
                needsClarification: true,
                completedAt: null,
                cancelledAt: null,
              },
              true,
            )
          : await taskActions.setStatus(task, nextStatus);
      if (!updated) setStatusDraft(previousStatus);
    } catch (err) {
      setStatusDraft(previousStatus);
      setSaveError(localizedErrorMessage(err, strings));
    } finally {
      setChangingStatus(false);
    }
  };

  const runDependencySearch = async (value: string) => {
    setDepQuery(value);
    setDependencyError(null);
    if (!value.trim()) {
      setDepResults([]);
      return;
    }
    try {
      const results = await api.searchTasks({ text: value });
      setDepResults(
        task
          ? sortDependencyCandidates(results, task, value, locale).slice(0, 8)
          : [],
      );
    } catch (err) {
      setDepResults([]);
      setDependencyError({
        candidateTaskId: null,
        message: localizedErrorMessage(err, strings),
      });
    }
  };

  const addTaskDependency = async (dependsOnTask: Task) => {
    if (!task || addingDependencyId !== null) return;
    setAddingDependencyId(dependsOnTask.id);
    setDependencyError(null);
    try {
      await api.addDependency(task.id, dependsOnTask.id);
      setDepQuery("");
      setDepResults([]);
      bump();
      reload();
    } catch (err) {
      setDependencyError({
        candidateTaskId: dependsOnTask.id,
        message: hasApiErrorCode(err, "task_dependency_cycle")
          ? strings.dependencyCycleExplanation(dependsOnTask.title, task.title)
          : localizedErrorMessage(err, strings),
      });
    } finally {
      setAddingDependencyId(null);
    }
  };

  const saveExternalWait = async () => {
    if (!task || !externalWaitDateValid) return;
    setSaveError(null);
    const updated = await taskActions.setExternalWait({
      id: task.id,
      revision: revisionRef.current ?? task.revision,
    }, {
      waitingFor: externalWaitDraft.trim(),
      scheduledDate: externalWaitDateDraft || null,
    });
    if (updated) revisionRef.current = updated.revision;
  };

  const resolveExternalWait = async () => {
    if (!task) return;
    setSaveError(null);
    const updated = await taskActions.resolveExternalWait({
      id: task.id,
      revision: revisionRef.current ?? task.revision,
    });
    if (updated) {
      revisionRef.current = updated.revision;
      setExternalWaitDraft("");
      setExternalWaitDateDraft("");
    }
  };

  const isCapturedInboxItem =
    task?.status === "captured" &&
    task.projectId === null &&
    task.parentTaskId === null;
  const taskMutationPending = task ? taskActions.isPending(task.id) : false;

  return (
    <>
    <BottomSheet
      title={strings.taskDetails}
      onClose={() => {
        if (
          !savingTextFields &&
          !classificationBusy &&
          !deleting &&
          !taskMutationPending
        ) {
          close();
        }
      }}
      labelledBy="task-detail-title"
      headerActions={
        task ? (
          <>
            <NativeShareButton
              title={task.title}
              text={serializeTaskForShare(task, locale)}
              url={buildTaskShareUrl(task.id)}
              showStatus={false}
              onStatusChange={setShareStatus}
            />
            <CalendarExportButton
              item={{
                kind: "task",
                id: task.id,
                title: task.title,
                notes: task.notes,
                dueDate: task.dueDate,
              }}
              showStatus={false}
              onStatusChange={setShareStatus}
            />
          </>
        ) : null
      }
      headerStatus={
        shareStatus ? (
          <span className="text-muted native-share-status" role="status">
            {shareStatus}
          </span>
        ) : null
      }
    >
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {task ? (
        <fieldset
          className="stack task-detail-content"
          disabled={taskMutationPending}
          aria-busy={taskMutationPending}
          style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
        >
          {task.blocked ? <div className="badge badge-status-waiting">{strings.blockedHint}</div> : null}

          <TaskDetailSection title={strings.taskSection}>
            <div className="field" ref={titleFieldRef}>
              <div className="row-between">
                <label className="field-label" htmlFor="task-title">
                  {strings.title}
                </label>
                {!titleEditing ? (
                  <IconActionButton
                    kind="edit"
                    label={strings.edit}
                    onClick={() => setTitleEditing(true)}
                  />
                ) : null}
              </div>
              {titleEditing ? (
                <>
                  <input
                    ref={titleInputRef}
                    id="task-title"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                  />
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={savingTextFields}
                      onClick={cancelTitleEdit}
                    >
                      {strings.cancel}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={!titleIsValid || !titleDirty || savingTextFields}
                      onClick={() =>
                        void saveContentField("title").then((saved) => {
                          if (saved) setTitleEditing(false);
                        })
                      }
                    >
                      {strings.save}
                    </button>
                  </div>
                </>
              ) : (
                <strong>{task.title}</strong>
              )}
            </div>

            {!isCapturedInboxItem ? <div className="field">
              <label htmlFor="task-status">{strings.status}</label>
              <select
                id="task-status"
                value={statusDraft}
                disabled={
                  changingStatus ||
                  taskActions.isPending(task.id) ||
                  taskActions.pendingTask?.id === task.id
                }
                onChange={(e) => void changeStatus(e.target.value as Task["status"])}
              >
                {taskStatuses
                  .filter((status) => status !== "captured" || task.status === "captured")
                  .map((s) => (
                  <option key={s} value={s}>
                    {strings.taskStatusLabels[s]}
                  </option>
                  ))}
              </select>
            </div> : null}

            <div className="field" ref={ownerFieldRef}>
              {task.ownerInheritanceMode !== "explicit" ? <label>{strings.owner}</label> : null}
              <InheritanceControl
                focusRef={ownerInputRef}
                mode={task.ownerInheritanceMode}
                onChange={(mode) => void patch({ ownerInheritanceMode: mode })}
              />
              {task.ownerInheritanceMode === "explicit" ? (
                <MemberChoiceGroup
                  label={strings.owner}
                  idPrefix={`task-owner-${task.id}`}
                  members={members}
                  value={task.ownerMemberId}
                  onChange={(ownerMemberId) => void patch({ ownerMemberId })}
                  unassignedLabel={strings.unassigned}
                />
              ) : (
                <p className="text-muted">
                  {(() => {
                    const owner = members.find(
                      (member) => member.id === task.effectiveOwnerId,
                    );
                    return owner ? (
                      <MemberLabel member={owner} size="sm" />
                    ) : (
                      strings.unassigned
                    );
                  })()}
                </p>
              )}
            </div>
          </TaskDetailSection>

          {isCapturedInboxItem ? (
            <TaskDetailSection title={strings.classificationPrompt}>
              <div className="capture-shape-actions">
                <button
                  type="button"
                  className="btn btn-primary capture-shape-action"
                  disabled={classificationBusy || contentDirty}
                  onClick={() => void classifyCapture("actionable")}
                >
                  {strings.classifyAsAction}
                </button>
                <button
                  type="button"
                  className="btn btn-primary capture-shape-action"
                  disabled={classificationBusy || contentDirty}
                  onClick={() => void promoteCapture(true)}
                >
                  {strings.classifyAsProjectSteps}
                </button>
                <button
                  type="button"
                  className="btn capture-shape-action"
                  disabled={classificationBusy || contentDirty}
                  onClick={() => void promoteCapture(false)}
                >
                  {strings.classifyAsBacklog}
                </button>
                <button
                  type="button"
                  className="btn capture-shape-action"
                  disabled={classificationBusy || contentDirty}
                  onClick={() => void classifyCapture("someday")}
                >
                  {strings.classifyAsSomeday}
                </button>
              </div>
            </TaskDetailSection>
          ) : null}

          <TaskDetailSection title={strings.taskPlanningSection}>
            <div className="row task-detail-date-row">
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="task-due">{strings.due}</label>
              <HumanDateInput
                id="task-due"
                value={task.dueDate ?? ""}
                onChange={(dueDate) => void patch({ dueDate })}
                onValidityChange={setDueDateValid}
                disabled={task.repeatAfterDays !== null}
              />
              {task.repeatAfterDays !== null ? (
                <span className="text-muted recurrence-derived-hint">
                  {strings.recurrenceDeadlineLocked}
                </span>
              ) : null}
            </div>
            {!task.externalWait ? (
              <div className="field" style={{ flex: 1 }} ref={scheduleFieldRef}>
                <label htmlFor="task-scheduled">
                  {task.blocked ? strings.revisitDate : strings.scheduled}
                </label>
                <HumanDateInput
                  inputRef={scheduleInputRef}
                  id="task-scheduled"
                  value={task.scheduledDate ?? ""}
                  onChange={(scheduledDate) => void patch({ scheduledDate })}
                  onValidityChange={setScheduledDateValid}
                />
              </div>
            ) : null}
            </div>
          {task.repeatAfterDays === null && !task.externalWait ? (
            <ScheduleShortcuts
              value={task.scheduledDate}
              onChange={(scheduledDate) => void patch({ scheduledDate })}
            />
          ) : null}

          <div className="field">
            <label htmlFor="task-priority">{strings.priority}</label>
            <select
              id="task-priority"
              value={task.priority ?? ""}
              onChange={(e) => void patch({ priority: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">{strings.none}</option>
              <option value="1">1 – {strings.priorityHighest}</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5 – {strings.priorityLowest}</option>
            </select>
          </div>
          </TaskDetailSection>

          <TaskDetailDisclosure
            title={strings.recurrence}
            defaultOpen={task.repeatAfterDays !== null}
            resetKey={task.id}
            className="task-detail-recurrence"
          >
            <div className="recurrence-editor">
            <div className="row-between">
              <p className="text-muted">{strings.recurrenceHint}</p>
              <label className="recurrence-toggle">
                <input
                  type="checkbox"
                  checked={task.repeatAfterDays !== null}
                  onChange={(event) => {
                    if (!event.target.checked) {
                      void patch({
                        repeatAfterDays: null,
                        allowedDeviationDays: null,
                      });
                      return;
                    }
                    if (!task.scheduledDate) {
                      setSaveError(strings.recurrenceScheduleRequired);
                      return;
                    }
                    setSaveError(null);
                    void patch({
                      repeatAfterDays: 7,
                      allowedDeviationDays: 0,
                    });
                  }}
                />
                <span>{strings.recurrenceEnabled}</span>
              </label>
            </div>
            {task.repeatAfterDays !== null &&
            task.allowedDeviationDays !== null ? (
              <>
                <div className="recurrence-number-grid">
                  <label className="field">
                    <span>{strings.repeatAfterDays}</span>
                    <input
                      key={`repeat-${task.id}-${task.repeatAfterDays}`}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step={1}
                      defaultValue={task.repeatAfterDays}
                      onBlur={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isInteger(value) && value >= 1) {
                          void patch({ repeatAfterDays: value });
                        }
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>{strings.allowedDeviationDays}</span>
                    <input
                      key={`deviation-${task.id}-${task.allowedDeviationDays}`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      defaultValue={task.allowedDeviationDays}
                      onBlur={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isInteger(value) && value >= 0) {
                          void patch({ allowedDeviationDays: value });
                        }
                      }}
                    />
                  </label>
                </div>
                <p className="recurrence-preview">
                  {strings.recurrenceDeadlinePreview(
                    formatExactLocalDate(task.dueDate ?? "", locale) ??
                      task.dueDate ??
                      "–",
                  )}
                </p>
              </>
            ) : null}
            </div>
          </TaskDetailDisclosure>

          <TaskDetailSection title={strings.taskContentSection}>
            <div className="field">
            <label>{strings.effectiveTags}</label>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {task.explicitTags.length === 0 && inheritedTags.length === 0 ? (
                <span className="text-muted">{strings.noTags}</span>
              ) : null}
              {inheritedTags.map((tag) => {
                const excluded = task.excludedTagIds.includes(tag.id);
                return (
                  <TagChip
                    key={tag.id}
                    tag={tag}
                    excluded={excluded}
                    onToggleExclude={() =>
                      void patch({
                        excludedTagIds: excluded
                          ? task.excludedTagIds.filter((id) => id !== tag.id)
                          : [...task.excludedTagIds, tag.id],
                      })
                    }
                  />
                );
              })}
            </div>
            <TagPicker
              tags={tags ?? []}
              selectedIds={task.explicitTags.map((tag) => tag.id)}
              hiddenIds={inheritedTags.map((tag) => tag.id)}
              onChange={(tagIds) => patch({ tagIds })}
            />
          </div>

          <div className="field task-notes-field">
            <div className="row-between">
              <label className="field-label" htmlFor="task-notes">{strings.notes}</label>
              {!notesEditing ? (
                <IconActionButton
                  kind="edit"
                  label={strings.edit}
                  onClick={() => setNotesEditing(true)}
                />
              ) : null}
            </div>
            {notesEditing ? (
              <>
                <MarkdownEditor
                  id="task-notes"
                  ref={notesRef}
                  value={notesDraft}
                  onChange={setNotesDraft}
                  toolbarLabel={strings.markdownToolbar}
                  rows={6}
                />
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={savingTextFields}
                    onClick={cancelNotesEdit}
                  >
                    {strings.cancel}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={!notesDirty || savingTextFields}
                    onClick={() =>
                      void saveContentField("notes").then((saved) => {
                        if (saved) setNotesEditing(false);
                      })
                    }
                  >
                    {strings.saveNotes}
                  </button>
                </div>
              </>
            ) : notesDraft.trim() ? (
              <MarkdownNotes value={notesDraft} />
            ) : (
              <p className="text-muted">{strings.noNotes}</p>
            )}
          </div>

          {saveError ?? taskActions.errors[task.id] ? (
            <div className="task-row-error" role="alert">
              <span>{strings.error}</span>
              <span className="text-muted">{saveError ?? taskActions.errors[task.id]}</span>
            </div>
          ) : null}
          </TaskDetailSection>

          <TaskDetailSection title={strings.waitingFor}>
            <div className="field" ref={dependenciesFieldRef}>
            <div className="stack blocker-control">
              <div className="field">
                <label htmlFor="task-external-wait">{strings.externalWait}</label>
                <input
                  id="task-external-wait"
                  value={externalWaitDraft}
                  placeholder={strings.waitingForPlaceholder}
                  onChange={(event) => setExternalWaitDraft(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="task-external-wait-date">
                  {strings.revisitDate}
                </label>
                <HumanDateInput
                  id="task-external-wait-date"
                  value={externalWaitDateDraft}
                  onChange={(date) => setExternalWaitDateDraft(date ?? "")}
                  onValidityChange={setExternalWaitDateValid}
                />
              </div>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={!externalWaitDraft.trim() || !externalWaitDateValid || taskMutationPending}
                  onClick={() => void saveExternalWait()}
                >
                  {task.externalWait ? strings.updateExternalWait : strings.addExternalWait}
                </button>
                {task.externalWait ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={taskMutationPending}
                    onClick={() => void resolveExternalWait()}
                  >
                    {strings.resolveExternalWait}
                  </button>
                ) : null}
              </div>
            </div>
            <label>{strings.dependencies}</label>
            {task.dependencies.length === 0 ? <p className="text-muted">{strings.noDependencies}</p> : null}
            <ul className="list" style={{ padding: 0, margin: 0 }}>
              {sortDependencies(task.dependencies, locale).map((dep) => (
                <li key={dep.id} className="row-between">
                  <span>{dep.title ?? `#${dep.dependsOnTaskId}`}</span>
                  <span className="row">
                    <span className="text-muted">{dep.resolved ? strings.resolved : strings.unresolved}</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => void api.removeDependency(task.id, dep.dependsOnTaskId).then(() => { bump(); reload(); })}
                    >
                      {strings.removeDependency}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <input
              ref={dependencyInputRef}
              aria-label={strings.searchDependency}
              placeholder={strings.searchDependency}
              value={depQuery}
              onChange={(e) => void runDependencySearch(e.target.value)}
            />
            {depResults.length > 0 ? (
              <ul className="list" style={{ padding: 0, margin: 0 }}>
                {depResults.map((t) => (
                  <li key={t.id} className="stack">
                    <button
                      type="button"
                      className="btn btn-sm btn-block"
                      disabled={addingDependencyId !== null}
                      onClick={() => void addTaskDependency(t)}
                    >
                      {strings.addDependency}: {t.title}
                      {t.projectTitle ? (
                        <span className="text-muted"> · {t.projectTitle}</span>
                      ) : null}
                    </button>
                    {dependencyError?.candidateTaskId === t.id ? (
                      <div className="task-row-error" role="alert">
                        <span>{strings.error}</span>
                        <span className="text-muted">{dependencyError.message}</span>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {dependencyError?.candidateTaskId === null ? (
              <div className="task-row-error" role="alert">
                <span>{strings.error}</span>
                <span className="text-muted">{dependencyError.message}</span>
              </div>
            ) : null}
            </div>
          </TaskDetailSection>

          <TaskDetailSection title={strings.subtasks}>
            <div className="field" ref={subtasksFieldRef}>
            {task.children.length === 0 ? <p className="text-muted">{strings.noTasks}</p> : null}
            <ul className="list" style={{ padding: 0, margin: 0 }}>
              {sortByPosition(task.children).map((child) => (
                <li key={child.id} className="row-between">
                  <span className="row">
                    <button
                      type="button"
                      className={`task-row-checkbox${child.status === "done" ? " done" : ""}${child.status === "cancelled" ? " cancelled" : ""}`}
                      aria-label={child.status === "done" || child.status === "cancelled" ? strings.reopen : strings.done}
                      onClick={() => {
                        taskActions.requestToggle(child);
                        reload();
                      }}
                    >
                      {child.status === "done" ? "✓" : child.status === "cancelled" ? "×" : ""}
                    </button>
                    <button type="button" className="link-plain" onClick={() => open(child.id)}>
                      {child.title}
                    </button>
                  </span>
                  <StatusBadge status={child.status} />
                </li>
              ))}
            </ul>
            {task.repeatAfterDays === null && !isCapturedInboxItem ? (
              addingChild ? (
                <InlineChildComposer
                  parentId={task.id}
                  onCancel={() => setAddingChild(false)}
                  onCreated={() => {
                    setAddingChild(false);
                    reload();
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setAddingChild(true)}
                >
                  {strings.addChild}
                </button>
              )
            ) : task.repeatAfterDays !== null ? (
              <p className="text-muted">{strings.recurringTaskLeafHint}</p>
            ) : null}
            </div>
          </TaskDetailSection>

          <TaskDetailDisclosure
            title={strings.taskOrganizationSection}
            resetKey={task.id}
          >
            <div className="field">
            <label>{strings.organizeControls}</label>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button type="button" className="btn btn-sm" onClick={() => setMovePrompt("parent")}>
                {strings.changeParent}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setMovePrompt("project")}>
                {strings.moveProject}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setMovePrompt("subtree")}>
                {strings.moveSubtree}
              </button>
            </div>
            </div>

            <p className="text-muted task-detail-metadata">
              {strings.created}: {formatDateTime(task.createdAt, locale)} ·{" "}
              {strings.updated}: {formatDateTime(task.updatedAt, locale)}
            </p>
          </TaskDetailDisclosure>

          {task.repeatAfterDays !== null ||
          (recurrenceHistory?.summary.totalCount ?? 0) > 0 ? (
            <section
              className="recurrence-history"
              aria-labelledby="recurrence-history-title"
            >
              <div className="row-between">
                <h3 id="recurrence-history-title">
                  {strings.recurrenceHistory}
                </h3>
                {recurrenceHistory &&
                recurrenceHistory.summary.totalCount > 0 ? (
                  <strong>
                    {strings.recurrenceHitRate(
                      new Intl.NumberFormat(locale, {
                        style: "percent",
                        maximumFractionDigits: 0,
                      }).format(recurrenceHistory.summary.hitRate ?? 0),
                    )}
                  </strong>
                ) : null}
              </div>
              {recurrenceHistoryLoading && !recurrenceHistory ? (
                <p className="text-muted">{strings.loading}</p>
              ) : null}
              {recurrenceHistoryError && !recurrenceHistory ? (
                <p role="alert">
                  {strings.recurrenceHistoryLoadError}{" "}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={reloadRecurrenceHistory}
                  >
                    {strings.retry}
                  </button>
                </p>
              ) : null}
              {recurrenceHistory?.summary.totalCount === 0 ? (
                <p className="text-muted">{strings.recurrenceHistoryEmpty}</p>
              ) : null}
              {recurrenceHistory &&
              recurrenceHistory.summary.totalCount > 0 ? (
                <>
                  <p className="recurrence-history-summary">
                    <span className="recurrence-hit">
                      +{recurrenceHistory.summary.hitCount}{" "}
                      {strings.recurrenceHits}
                    </span>
                    <span className="recurrence-miss">
                      −{recurrenceHistory.summary.missCount}{" "}
                      {strings.recurrenceMisses}
                    </span>
                  </p>
                  <ul className="recurrence-history-list">
                    {recurrenceHistory.occurrences.slice(0, 10).map((row) => (
                      <li key={row.id}>
                        <div className="row-between">
                          <span>
                            {strings.recurrenceCompletedOn(
                              formatExactLocalDate(row.completedOn, locale) ??
                                row.completedOn,
                            )}
                          </span>
                          <span
                            className={`badge recurrence-result-${row.result}`}
                          >
                            {row.result === "hit"
                              ? strings.recurrenceHit
                              : strings.recurrenceMiss}
                          </span>
                        </div>
                        <small className="text-muted">
                          {strings.recurrenceOccurrenceDates(
                            formatExactLocalDate(row.scheduledDate, locale) ??
                              row.scheduledDate,
                            formatExactLocalDate(row.deadlineDate, locale) ??
                              row.deadlineDate,
                          )}
                        </small>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ) : null}

          <RecentActivity
            key={`task-activity-${task.id}`}
            filters={{ taskId: task.id }}
            idPrefix={`task-${task.id}-activity`}
          />

          <TaskDetailDisclosure
            title={strings.taskDangerSection}
            resetKey={task.id}
            className="task-detail-danger"
          >
            <button
              type="button"
              className="btn btn-danger btn-block"
              disabled={deleting}
              onClick={() => {
                if (window.confirm(strings.deleteTaskConfirm)) {
                  setDeleting(true);
                  setSaveError(null);
                  void api
                    .deleteTask(task.id)
                    .then(() => {
                      bump();
                      close();
                    })
                    .catch((cause) => {
                      setSaveError(localizedErrorMessage(cause, strings));
                      setDeleting(false);
                    });
                }
              }}
            >
              {strings.delete}
            </button>
          </TaskDetailDisclosure>
        </fieldset>
      ) : null}

      {taskActions.pendingTask ? (
        <ChildPolicyPrompt
          taskTitle={taskActions.pendingTask.title}
          action={taskActions.pendingAction ?? "complete"}
          onChoose={(policy) => {
            taskActions.resolvePolicy(policy);
            reload();
          }}
          onClose={() => {
            setStatusDraft(task?.status ?? "actionable");
            taskActions.cancelPrompt();
          }}
        />
      ) : null}

      {movePrompt && task ? (
        <MoveTaskSheet
          task={task}
          mode={movePrompt}
          onClose={() => {
            setMovePrompt(null);
            reload();
          }}
        />
      ) : null}
    </BottomSheet>
    {promotedProject ? (
      <CapturedProjectHandoff
        project={promotedProject}
        onDone={() => {
          setPromotedProject(null);
          finishClassification();
        }}
      />
    ) : null}
    </>
  );
}
