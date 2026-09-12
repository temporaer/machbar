import {
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Task } from "@machbar/shared";
import { taskStatuses } from "@machbar/shared";
import { api } from "../lib/api";
import type { ProjectWithActions } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { useTaskActions } from "../lib/useTaskActions";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useTaskDetail } from "../lib/taskDetailContext";
import { WorkItemBreadcrumbs } from "./WorkItemBreadcrumbs";
import { useStrings } from "../lib/strings";
import { formatDateTime } from "../lib/format";
import { formatExactLocalDate } from "../lib/relativeDate";
import { isCapturedInboxItem, sortByPosition } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";
import { LoadingState, ErrorState } from "./AsyncStates";
import { StatusBadge } from "./StatusBadge";
import { DetailPropertyPill } from "./DetailPropertyPill";
import { ChildPolicyPrompt } from "./ChildPolicyPrompt";
import { ConfirmDeleteSheet } from "./ConfirmDeleteSheet";
import { WorkItemInlineError } from "./WorkItemInlineError";
import { CapturedProjectHandoff } from "./CapturedProjectHandoff";
import { MemberLabel } from "./MemberAvatar";
import { TaskCardTags } from "./TaskCardTags";
import {
  insertMarkdownAtSelection,
  MarkdownEditor,
} from "./MarkdownEditor";
import { MarkdownNotes } from "./MarkdownNotes";
import { NativeShareButton } from "./NativeShareButton";
import { CalendarExportButton } from "./CalendarExportButton";
import { IconActionButton } from "./IconActionButton";
import { serializeTaskForShare } from "../lib/shareText";
import { buildTaskShareUrl } from "../lib/shareUrls";
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
import { recencyRankLookup, recordRecentlyViewed } from "../lib/recentlyViewed";
import {
  containsPaperlessReference,
  extractPaperlessReferences,
} from "../lib/paperlessAttachments";
import { appendTextBlock } from "../lib/shareTarget";
import { MarkdownAttachmentSheet } from "./MarkdownAttachmentSheet";
import { PaperlessAttachmentStrip } from "./PaperlessAttachmentStrip";
import { WorkItemDetailDisclosure } from "./WorkItemDetailSection";
import { taskRailCommands } from "../lib/railConfig";
import { ActionTileGrid } from "./ActionTileGrid";
import { formatReminderSummary } from "../lib/reminderLabels";

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

/**
 * The document-like view of one work item: what it is (title), the small set
 * of scalar properties it currently has, and its actual content (notes,
 * subtasks, dependencies, history).
 *
 * This sheet owns no scalar-property editor. Every scalar property renders as
 * a compact value that dispatches its canonical semantic command
 * (`task.plan`, `task.assignOwner`, `task.waitingLifecycle`, …), which
 * `useWorkItemCommands()` routes into the one focused workflow that also
 * serves the row rail, the keyboard, and Review's repairs. Properties that
 * are unset stay invisible unless they are common enough to deserve a
 * lightweight affordance; everything else is reachable through
 * `Weitere Aktionen`.
 *
 * What remains here is genuinely document-shaped and has no other home:
 * authored text (title/notes, with explicit Edit/Save/Cancel), the subtask
 * and dependency collections, activity/recurrence history, the explicit
 * refile/move tools (`Sortier-Werkzeuge`) that compiled views cannot reach
 * through outline drag editing, and permanent deletion.
 */
export function TaskDetailSheet() {
  const strings = useStrings();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const { openTaskId, queueActive, focusField, clearFocusField, open, advanceQueue, close } = useTaskDetail();
  const { bump } = useRefresh();
  const { members } = useIdentity();
  const taskActions = useTaskActions();
  const dispatch = useWorkItemCommands();
  const taskWorkflow = useTaskWorkflow();
  const [depQuery, setDepQuery] = useState("");
  const [depResults, setDepResults] = useState<Task[]>([]);
  const [dependencyError, setDependencyError] = useState<{
    candidateTaskId: number | null;
    message: string;
  } | null>(null);
  const [addingDependencyId, setAddingDependencyId] = useState<number | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [textFieldsBaseline, setTextFieldsBaseline] = useState<TextFieldsSnapshot | null>(null);
  const [savingTextFields, setSavingTextFields] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [notesEditing, setNotesEditing] = useState(false);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [addingDependency, setAddingDependency] = useState(false);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [classificationBusy, setClassificationBusy] = useState(false);
  const [convertedProject, setConvertedProject] =
    useState<ProjectWithActions | null>(null);
  const titleFieldRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const dependenciesFieldRef = useRef<HTMLDivElement>(null);
  const dependencyInputRef = useRef<HTMLInputElement>(null);
  const lastLoadedTaskIdRef = useRef<number | null>(null);
  const revisionRef = useRef<number | null>(null);
  const workflowKind = taskWorkflow.current?.kind ?? null;

  const {
    data: loadedTask,
    loading,
    error,
    reload,
  } = useAsync(() => (openTaskId ? api.getTask(openTaskId) : Promise.resolve(null)), [openTaskId]);
  const task = loadedTask
    ? (taskActions.retained.get(loadedTask.id) ?? loadedTask)
    : null;

  // Recency is a soft ranking boost for search/pickers, not domain state —
  // record it once per genuine open, not on every re-render/reload.
  useEffect(() => {
    if (openTaskId) recordRecentlyViewed("task", openTaskId);
  }, [openTaskId]);
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
      setAttachmentOpen(false);
      setAddingDependency(false);
      setLifecycleOpen(false);
      setDeleting(false);
      setShareStatus(null);
      setDependencyError(null);
      setAddingDependencyId(null);
      setConvertedProject(null);
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

  // A focused workflow launched from here commits against the same task, so
  // its scalar values are stale once it closes.
  useEffect(() => {
    if (workflowKind === null && lastLoadedTaskIdRef.current !== null) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowKind]);

  // Focus hints only address this sheet's own document content; scalar
  // properties are reached through their semantic command instead.
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
    if (focusField === "attachment") {
      setAttachmentOpen(true);
      clearFocusField();
      return;
    }
    if (focusField === "dependencies" && !addingDependency) {
      setAddingDependency(true);
      return;
    }
    const scrollTarget =
      focusField === "title"
        ? titleFieldRef.current
        : focusField === "notes"
          ? notesRef.current
          : dependenciesFieldRef.current;
    const focusTarget =
      focusField === "title"
        ? titleInputRef.current
        : focusField === "notes"
          ? notesRef.current
          : dependencyInputRef.current;
    if (scrollTarget) {
      if (typeof scrollTarget.scrollIntoView === "function") {
        scrollTarget.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      focusTarget?.focus();
    }
    clearFocusField();
  }, [
    task,
    focusField,
    clearFocusField,
    notesEditing,
    titleEditing,
    addingDependency,
  ]);

  if (openTaskId === null) return null;

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

  const convertTaskToProject = async () => {
    if (!task || classificationBusy || contentDirty) return;
    setClassificationBusy(true);
    setSaveError(null);
    try {
      const project = await api.convertTaskToStory(task.id, {
        status: "backlog",
        expectedRevision: revisionRef.current ?? task.revision,
      });
      bump();
      setConvertedProject(project);
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
          ? sortDependencyCandidates(results, task, value, locale, {
              recencyRank: recencyRankLookup("task"),
            }).slice(0, 8)
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
      setAddingDependency(false);
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

  const taskIsCapturedInboxItem = task ? isCapturedInboxItem(task) : false;
  const taskMutationPending = task ? taskActions.isPending(task.id) : false;
  const unresolvedDependencyCount =
    task?.dependencies.filter((dependency) => !dependency.resolved).length ?? 0;
  const attachments = extractPaperlessReferences(notesDraft);
  const projectOwner = task
    ? members.find((member) => member.id === task.projectOwnerMemberId)
    : undefined;
  const effectiveOwner = task
    ? members.find((member) => member.id === task.effectiveOwnerId)
    : undefined;
  const localDate = (value: string) =>
    formatExactLocalDate(value, locale) ?? value;
  const planValue = task
    ? [
        task.scheduledDate ? localDate(task.scheduledDate) : null,
        task.dueDate ? `${strings.due} ${localDate(task.dueDate)}` : null,
      ]
        .filter((value): value is string => value !== null)
        .join(" · ")
    : "";
  const reminderSummary = task
    ? formatReminderSummary(task.reminders, task.dueDate, strings, locale)
    : null;
  const waitValue = task?.externalWait
    ? [
        task.externalWait.waitingFor?.trim() ?? null,
        task.externalWait.revisitDate
          ? localDate(task.externalWait.revisitDate)
          : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ")
    : "";

  const runCommand = (
    command: (typeof taskRailCommands)[number] | "task.changeParent" | "task.discard" | "task.reminders",
  ) => {
    if (!task) return;
    if (command === "task.lifecycle") {
      setLifecycleOpen((current) => !current);
      return;
    }
    if (command === "task.discard") {
      dispatch({ type: command, task });
      return;
    }
    dispatch({ type: command, taskId: task.id });
  };

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
            <IconActionButton
              kind="attachment"
              label={strings.attach}
              disabled={taskMutationPending}
              onClick={() => setAttachmentOpen(true)}
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
          {loadedTask?.ancestors?.length ? (
            <WorkItemBreadcrumbs ancestors={loadedTask.ancestors} />
          ) : null}
          <div className="field" ref={titleFieldRef}>
            {titleEditing ? (
              <>
                <label className="field-label" htmlFor="task-title">
                  {strings.title}
                </label>
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
              <div className="task-detail-title-row">
                <h1>
                  {task.title}
                  <IconActionButton
                    kind="edit"
                    label={strings.edit}
                    onClick={() => setTitleEditing(true)}
                  />
                </h1>
              </div>
            )}
          </div>

          <div className="detail-meta-row">
            {taskIsCapturedInboxItem ? <span className="sr-only">{strings.status}: </span> : null}
            <StatusBadge
              status={task.status}
              {...(taskIsCapturedInboxItem ? {} : { onClick: () => runCommand("task.lifecycle") })}
            />
            {task.projectId !== null && task.projectTitle ? (
              <span className="detail-meta-static">
                <span className="detail-meta-label">{strings.project}</span>
                <Link
                  className="task-project-context-link"
                  to={`/projects/${task.projectId}`}
                  onClick={close}
                >
                  {task.projectTitle}
                </Link>
                {projectOwner ? (
                  <MemberLabel member={projectOwner} size="xs" />
                ) : null}
              </span>
            ) : null}
            {effectiveOwner ? (
              <DetailPropertyPill
                label={strings.owner}
                onClick={() => runCommand("task.assignOwner")}
              >
                <MemberLabel member={effectiveOwner} size="xs" />
              </DetailPropertyPill>
            ) : (
              <DetailPropertyPill
                variant="unset"
                onClick={() => runCommand("task.assignOwner")}
              >
                {strings.addOwner}
              </DetailPropertyPill>
            )}
            {planValue ? (
              <DetailPropertyPill
                label={strings.taskPlanFor}
                onClick={() => runCommand("task.plan")}
              >
                <span>{planValue}</span>
              </DetailPropertyPill>
            ) : (
              <DetailPropertyPill variant="unset" onClick={() => runCommand("task.plan")}>
                {strings.addPlan}
              </DetailPropertyPill>
            )}
            {task.reminders.length > 0 && reminderSummary ? (
              <DetailPropertyPill
                label={strings.reminders}
                onClick={() => runCommand("task.reminders")}
              >
                <span>
                  {reminderSummary.label}
                  {reminderSummary.overflowCount > 0 ? ` +${reminderSummary.overflowCount}` : ""}
                </span>
              </DetailPropertyPill>
            ) : !taskIsCapturedInboxItem ? (
              <DetailPropertyPill variant="unset" onClick={() => runCommand("task.reminders")}>
                {strings.addReminder}
              </DetailPropertyPill>
            ) : null}
            {task.externalWait ? (
              <DetailPropertyPill
                label={strings.waitingFor}
                onClick={() => runCommand("task.waitingLifecycle")}
              >
                <span>{waitValue}</span>
              </DetailPropertyPill>
            ) : (
              <DetailPropertyPill
                variant="unset"
                onClick={() => runCommand("task.waitingLifecycle")}
              >
                {strings.addWaiting}
              </DetailPropertyPill>
            )}
            {task.repeatAfterDays !== null ? (
              <DetailPropertyPill
                label={strings.recurrence}
                onClick={() => runCommand("task.recurrence")}
              >
                <span>{strings.recurrenceEveryDays(task.repeatAfterDays)}</span>
              </DetailPropertyPill>
            ) : null}
            {task.priority !== null ? (
              <DetailPropertyPill
                label={strings.priority}
                onClick={() => runCommand("task.priority")}
              >
                <span>{task.priority}</span>
              </DetailPropertyPill>
            ) : null}
            {task.effectiveTags.length > 0 ? (
              <DetailPropertyPill
                ariaLabel={strings.tags}
                extraClassName="detail-meta-label-button"
                onClick={() => runCommand("task.tags")}
              >
                <TaskCardTags tags={task.effectiveTags} />
              </DetailPropertyPill>
            ) : (
              <DetailPropertyPill variant="unset" onClick={() => runCommand("task.tags")}>
                {strings.addTags}
              </DetailPropertyPill>
            )}
            {task.effectiveContexts.length > 0 ? (
              <DetailPropertyPill
                ariaLabel={strings.physicalContexts}
                extraClassName="detail-meta-label-button"
                onClick={() => runCommand("task.contexts")}
              >
                <TaskCardTags tags={[]} contexts={task.effectiveContexts} />
              </DetailPropertyPill>
            ) : (
              <DetailPropertyPill variant="unset" onClick={() => runCommand("task.contexts")}>
                {strings.addContexts}
              </DetailPropertyPill>
            )}
          </div>

          {lifecycleOpen ? (
            <div className="task-row-lifecycle" role="group" aria-label={strings.status}>
              {taskStatuses
                .filter((status) => status !== "captured" || task.status === "captured")
                .map((status) => (
                  <button
                    key={status}
                    type="button"
                    className="btn btn-sm"
                    disabled={task.status === status}
                    aria-current={task.status === status ? "true" : undefined}
                    onClick={() => {
                      setLifecycleOpen(false);
                      dispatch({ type: "task.setStatus", task, status });
                    }}
                  >
                    {strings.taskStatusLabels[status]}
                  </button>
                ))}
            </div>
          ) : null}

          <p className="text-muted task-detail-metadata">
            {strings.created}: {formatDateTime(task.createdAt, locale)} ·{" "}
            {strings.updated}: {formatDateTime(task.updatedAt, locale)}
          </p>

          {saveError ?? taskActions.errors[task.id] ? (
            <WorkItemInlineError message={saveError ?? taskActions.errors[task.id]!} />
          ) : null}

          <PaperlessAttachmentStrip attachments={attachments} />

          {taskIsCapturedInboxItem ? (
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
                onClick={() => void convertTaskToProject()}
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
          ) : null}

          <section className="section task-notes-section">
            <div className="row-between">
              <h2 className="section-title" id="task-notes-label">{strings.notes}</h2>
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
                <label className="sr-only" htmlFor="task-notes">{strings.notes}</label>
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
          </section>

          <WorkItemDetailDisclosure
            title={strings.subtasks}
            summary={
              task.children.length > 0
                ? strings.subtaskSummary(task.children.length)
                : strings.noSubtasks
            }
            defaultOpen={task.children.length > 0}
            resetKey={task.id}
          >
            <div className="field">
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
            {task.repeatAfterDays === null && !taskIsCapturedInboxItem ? (
              <div className="row">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => runCommand("task.split")}
                >
                  {strings.splitTask}
                </button>
              </div>
            ) : task.repeatAfterDays !== null ? (
              <p className="text-muted">{strings.recurringTaskLeafHint}</p>
            ) : null}
            </div>
          </WorkItemDetailDisclosure>

          <WorkItemDetailDisclosure
            title={strings.dependencies}
            summary={
              unresolvedDependencyCount > 0
                ? strings.dependencySummary(unresolvedDependencyCount)
                : undefined
            }
            defaultOpen={task.dependencies.length > 0}
            forceOpen={focusField === "dependencies"}
            resetKey={task.id}
          >
            <div className="stack blocker-control" ref={dependenciesFieldRef}>
              <ul className="list" style={{ padding: 0, margin: 0 }}>
                {sortDependencies(task.dependencies, locale).map((dep) => (
                  <li key={dep.id} className="row-between">
                    <span>{dep.title ?? `#${dep.dependsOnTaskId}`}</span>
                    <span className="row">
                      <span className="text-muted">
                        {dep.resolved ? strings.resolved : strings.unresolved}
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() =>
                          void api
                            .removeDependency(task.id, dep.dependsOnTaskId)
                            .then(() => {
                              bump();
                              reload();
                            })
                        }
                      >
                        {strings.removeDependency}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              {addingDependency ? (
                <div className="stack task-dependency-search">
                  <input
                    ref={dependencyInputRef}
                    aria-label={strings.searchDependency}
                    placeholder={strings.searchDependency}
                    value={depQuery}
                    onChange={(event) =>
                      void runDependencySearch(event.target.value)
                    }
                  />
                  {depResults.length > 0 ? (
                    <ul className="list" style={{ padding: 0, margin: 0 }}>
                      {depResults.map((candidate) => (
                        <li key={candidate.id} className="stack">
                          <button
                            type="button"
                            className="btn btn-sm btn-block"
                            disabled={addingDependencyId !== null}
                            onClick={() => void addTaskDependency(candidate)}
                          >
                            {strings.addDependency}: {candidate.title}
                            {candidate.projectTitle ? (
                              <span className="text-muted">
                                {" "}
                                · {candidate.projectTitle}
                              </span>
                            ) : null}
                          </button>
                          {dependencyError?.candidateTaskId === candidate.id ? (
                            <WorkItemInlineError message={dependencyError.message} />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {dependencyError?.candidateTaskId === null ? (
                    <WorkItemInlineError message={dependencyError.message} />
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setAddingDependency(false);
                      setDepQuery("");
                      setDepResults([]);
                      setDependencyError(null);
                    }}
                  >
                    {strings.cancel}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setAddingDependency(true)}
                >
                  {strings.addDependency}
                </button>
              )}
            </div>
          </WorkItemDetailDisclosure>

          <WorkItemDetailDisclosure
            title={strings.moreActions}
            resetKey={task.id}
            className="task-detail-commands"
          >
            <ActionTileGrid
              items={[
                ...(!taskIsCapturedInboxItem
                  ? ([
                      {
                        key: "task.changeProject",
                        icon: "project" as const,
                        label: strings.actionTileLabels["task.changeProject"],
                        onClick: () => runCommand("task.changeProject"),
                      },
                      {
                        key: "task.changeParent",
                        icon: "child" as const,
                        label: strings.actionTileLabels["task.changeParent"],
                        onClick: () => runCommand("task.changeParent"),
                      },
                      {
                        key: "task.convertToProject",
                        icon: "openProject" as const,
                        label: strings.actionTileLabels["task.convertToProject"],
                        onClick: () => runCommand("task.convertToProject"),
                      },
                    ] as const)
                  : []),
                {
                  key: "task.addSuccessor",
                  icon: "successor" as const,
                  label: strings.actionTileLabels["task.addSuccessor"],
                  onClick: () => runCommand("task.addSuccessor"),
                },
                ...(task.priority === null
                  ? [
                      {
                        key: "task.priority",
                        icon: "priority" as const,
                        label: strings.actionTileLabels["task.priority"],
                        onClick: () => runCommand("task.priority"),
                      },
                    ]
                  : []),
                ...(task.repeatAfterDays === null
                  ? [
                      {
                        key: "task.recurrence",
                        icon: "recurrence" as const,
                        label: strings.actionTileLabels["task.recurrence"],
                        onClick: () => runCommand("task.recurrence"),
                      },
                    ]
                  : []),
                {
                  key: "task.discard",
                  icon: "discard" as const,
                  label: strings.actionTileLabels["task.discard"],
                  onClick: () => runCommand("task.discard"),
                },
                ...(!taskIsCapturedInboxItem && task.projectId !== null
                  ? [
                      {
                        key: "task.toggleAdditionalNextAction",
                        icon: "actionable" as const,
                        label: task.additionalNextAction
                          ? strings.unmarkAdditionalNextAction
                          : strings.markAdditionalNextAction,
                        onClick: () =>
                          dispatch({ type: "task.toggleAdditionalNextAction", task }),
                      },
                    ]
                  : []),
              ]}
            />
          </WorkItemDetailDisclosure>

          {task.repeatAfterDays !== null ||
          (recurrenceHistory?.summary.totalCount ?? 0) > 0 ? (
            <WorkItemDetailDisclosure
              title={strings.recurrenceHistory}
              summary={
                recurrenceHistory && recurrenceHistory.summary.totalCount > 0
                  ? strings.recurrenceHitRate(
                      new Intl.NumberFormat(locale, {
                        style: "percent",
                        maximumFractionDigits: 0,
                      }).format(recurrenceHistory.summary.hitRate ?? 0),
                    )
                  : undefined
              }
              defaultOpen={task.repeatAfterDays !== null}
              resetKey={task.id}
              className="recurrence-history"
            >
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
            </WorkItemDetailDisclosure>
          ) : null}

          <RecentActivity
            key={`task-activity-${task.id}`}
            filters={{ taskId: task.id }}
            idPrefix={`task-${task.id}-activity`}
          />

          <WorkItemDetailDisclosure
            title={strings.taskDangerSection}
            resetKey={task.id}
            className="detail-danger-section"
          >
            <button
              type="button"
              className="btn btn-danger btn-block"
              disabled={deleting}
              onClick={() => setConfirmingDelete(true)}
            >
              {strings.delete}
            </button>
          </WorkItemDetailDisclosure>
        </fieldset>
      ) : null}

      {confirmingDelete && task ? (
        <ConfirmDeleteSheet
          title={strings.deleteTaskConfirmTitle}
          itemTitle={task.title}
          prompt={strings.deleteTaskConfirm}
          busy={deleting}
          onConfirm={() => {
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
          }}
          onClose={() => setConfirmingDelete(false)}
        />
      ) : null}

      {taskActions.pendingTask ? (
        <ChildPolicyPrompt
          taskTitle={taskActions.pendingTask.title}
          action={taskActions.pendingAction ?? "complete"}
          onChoose={(policy) => {
            taskActions.resolvePolicy(policy);
            reload();
          }}
          onClose={() => taskActions.cancelPrompt()}
        />
      ) : null}
    </BottomSheet>
    {attachmentOpen && task ? (
      <MarkdownAttachmentSheet
        onClose={() => setAttachmentOpen(false)}
        onInsert={async (markdown) => {
          if (notesEditing) {
            const current = notesRef.current;
            const transform = insertMarkdownAtSelection(
              current?.value ?? notesDraft,
              current?.selectionStart ?? notesDraft.length,
              current?.selectionEnd ?? notesDraft.length,
              markdown,
            );
            setNotesDraft(transform.value);
            queueMicrotask(() => {
              notesRef.current?.focus();
              notesRef.current?.setSelectionRange(
                transform.selectionStart,
                transform.selectionEnd,
              );
            });
            return;
          }
          if (containsPaperlessReference(task.notes, markdown)) return;
          const nextNotes = appendTextBlock(task.notes, markdown);
          setSaveError(null);
          try {
            const updated = await taskActions.update(
              task,
              { notes: nextNotes },
              { notes: nextNotes },
              true,
            );
            if (updated) {
              revisionRef.current = updated.revision;
              setNotesDraft(updated.notes);
              setTextFieldsBaseline(textFieldsSnapshot(updated));
            }
          } catch (cause) {
            if (isStaleWriteConflict(cause)) reload();
            setSaveError(localizedErrorMessage(cause, strings));
            throw cause;
          }
        }}
      />
    ) : null}
    {convertedProject ? (
      <CapturedProjectHandoff
        project={convertedProject}
        onDone={(options) => {
          const finishedProjectId = convertedProject.id;
          setConvertedProject(null);
          if (queueActive) {
            // Stay in the review queue so triage of the remaining Inbox
            // items isn't interrupted by a page change.
            finishClassification();
            return;
          }
          close();
          if (options?.openedProjectDirectly) return;
          // Land on Projects with the new backlog project auto-expanded and
          // highlighted instead of just closing back to wherever the sheet
          // was opened from, which is what made a converted item feel like
          // it had silently vanished.
          navigate("/projects", { state: { highlightProjectId: finishedProjectId } });
        }}
      />
    ) : null}
    </>
  );
}
