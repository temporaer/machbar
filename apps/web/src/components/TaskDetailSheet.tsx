import { useRetentionInteraction } from "../lib/useRetentionInteraction";
import { NotesAppend } from "./NotesAppend";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import type { Task } from "@machbar/shared";
import { taskStatuses } from "@machbar/shared";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { useTaskActions } from "../lib/useTaskActions";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useTaskDetail } from "../lib/taskDetailContext";
import { WorkItemBreadcrumbs } from "./WorkItemBreadcrumbs";
import { useStrings } from "../lib/strings";
import { ExternalRefBadge } from "./ExternalRefBadge";
import { formatDateTime } from "../lib/format";
import { formatExactLocalDate } from "../lib/relativeDate";
import { flattenTasks, isCapturedInboxItem } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";
import { LoadingState, ErrorState } from "./AsyncStates";
import { StatusBadge } from "./StatusBadge";
import { DetailPropertyPill } from "./DetailPropertyPill";
import { ChildPolicyPrompt } from "./ChildPolicyPrompt";
import { ConfirmDeleteSheet } from "./ConfirmDeleteSheet";
import { WorkItemInlineError } from "./WorkItemInlineError";
import { MemberLabel } from "./MemberAvatar";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { MarkdownNotes } from "./MarkdownNotes";
import { NativeShareButton } from "./NativeShareButton";
import { CalendarExportButton } from "./CalendarExportButton";
import { IconActionButton } from "./IconActionButton";
import { serializeTaskForShare } from "../lib/shareText";
import { buildTaskShareUrl } from "../lib/shareUrls";
import { RecentActivity } from "./RecentActivity";
import { useLocale } from "../lib/locale";
import {
  isStaleWriteConflict,
  localizedErrorMessage,
} from "../lib/errorMessage";
import {
  sortDependencies,
} from "../lib/sortOrder";
import { recordRecentlyViewed } from "../lib/recentlyViewed";
import {
  containsPaperlessReference,
  extractPaperlessReferences,
} from "../lib/paperlessAttachments";
import { appendTextBlock } from "../lib/shareTarget";
import { MarkdownAttachmentSheet } from "./MarkdownAttachmentSheet";
import { PaperlessAttachmentStrip } from "./PaperlessAttachmentStrip";
import { WorkItemDetailDisclosure } from "./WorkItemDetailSection";
import { AcceptanceCriteriaEditor } from "./AcceptanceCriteriaEditor";
import { DetailActionMenu } from "./DetailActionMenu";
import { formatReminderSummary } from "../lib/reminderLabels";
import { parseReferenceContent } from "../lib/referenceContent";

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
 * serves the fixed row rail (`Später`/`Struktur`), the keyboard, and
 * Review's repairs. Set values have direct editors; unset optional properties
 * live in the summary's More options menu. Tags and places stay one tap away.
 * The header action menu owns uncommon commands, sharing and attachments.
 *
 * What remains here is genuinely document-shaped and has no other home:
 * authored text (title/notes, with explicit Edit/Save/Cancel), the subtask
 * and dependency collections, activity/recurrence history, and permanent
 * deletion.
 */
export function TaskDetailSheet() {
  const strings = useStrings();
  const { locale } = useLocale();
  const { openTaskId, queueActive, focusField, clearFocusField, open, advanceQueue, close, suspended: detailSuspended } = useTaskDetail();
  const { bump } = useRefresh();
  const { members } = useIdentity();
  const dispatch = useWorkItemCommands();
  const taskWorkflow = useTaskWorkflow();
  const suspended = detailSuspended;
  const [titleDraft, setTitleDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [textFieldsBaseline, setTextFieldsBaseline] = useState<TextFieldsSnapshot | null>(null);
  const [savingTextFields, setSavingTextFields] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [criteriaError, setCriteriaError] = useState<string | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [notesEditing, setNotesEditing] = useState(false);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [makeActionBusy, setMakeActionBusy] = useState(false);
  const [makeActionError, setMakeActionError] = useState<string | null>(null);
  const [classificationBusy, setClassificationBusy] = useState(false);
  const titleFieldRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<MarkdownEditorHandle>(null);
  const dependenciesFieldRef = useRef<HTMLDivElement>(null);
  const lastLoadedTaskIdRef = useRef<number | null>(null);
  const revisionRef = useRef<number | null>(null);
  const workflowKind = taskWorkflow.current?.kind ?? null;

  const {
    data: loadedTask,
    loading,
    error,
    reload,
  } = useAsync(() => (openTaskId ? api.getTask(openTaskId) : Promise.resolve(null)), [openTaskId]);
  const taskActions = useTaskActions(flattenTasks(loadedTask ? [loadedTask] : []));
  useRetentionInteraction(openTaskId, taskActions.pauseRetention, openTaskId !== null);
  const task = loadedTask ? taskActions.projectTask(loadedTask) : null;

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
      setLifecycleOpen(false);
      setDeleting(false);
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
    if (focusField === "dependencies") {
      dispatch({ type: "task.plan", taskId: task.id, target: "dependencies" });
      clearFocusField();
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
          : null;
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
    dispatch,
  ]);

  if (openTaskId === null || suspended) return null;

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
    dispatch({ type: "task.convertToProject", taskId: task.id });
  };

  const isReference = task?.kind === "reference";
  const taskIsCapturedInboxItem = task && !isReference ? isCapturedInboxItem(task) : false;
  const taskMutationPending = task ? taskActions.isPending(task.id) : false;
  const unresolvedDependencyCount =
    task?.dependencies.filter((dependency) => !dependency.resolved).length ?? 0;
  const attachments = extractPaperlessReferences(notesDraft);
  const referenceContent = task && isReference ? parseReferenceContent(task.notes) : null;
  const projectOwner = task
    ? members.find((member) => member.id === task.projectOwnerMemberId)
    : undefined;
  const effectiveOwner = task
    ? members.find((member) => member.id === task.effectiveOwnerId)
    : undefined;
  const localDate = (value: string) =>
    formatExactLocalDate(value, locale) ?? value;
  const revisitAtValue = task?.revisitAt
    ? formatDateTime(task.revisitAt, locale)
    : null;
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
    command:
      | "task.lifecycle"
      | "task.assignOwner"
      | "task.availability"
      | "task.deferClarification"
      | "task.reminders"
      | "task.waitingLifecycle"
      | "task.recurrence"
      | "task.priority"
      | "task.tags"
      | "task.contexts"
      | "task.split"
      | "task.structure",
  ) => {
    if (!task) return;
    if (command === "task.lifecycle") {
      setLifecycleOpen((current) => !current);
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
            <IconActionButton
              kind="sparkles"
              label={strings.workRefinement}
              disabled={taskMutationPending || savingTextFields || classificationBusy || deleting}
              onClick={() => dispatch({ type: "task.refine", taskId: task.id })}
            />
            <DetailActionMenu label={strings.detailActions} resetKey={task.id}
              disabled={taskMutationPending || savingTextFields || classificationBusy || deleting}
              items={[
                { key: "discussion", icon: "followUp", label: task.discussionRequested ? strings.removeDiscussion : strings.addDiscussion,
                  onClick: () => { void dispatch({ type: "task.setDiscussion", task, requested: !task.discussionRequested })?.catch(() => {}); } },
                ...(!isReference && !taskIsCapturedInboxItem ? [{ key: "clarify", icon: "edit" as const,
                  label: task.needsClarification ? strings.clarifyNow : strings.clarifyAgain,
                  onClick: () => { void dispatch({ type: "task.setClarification", task, requested: !task.needsClarification })?.catch(() => {}); } }] : []),
                ...(!isReference && task.needsClarification ? [{ key: "clarifyLater", icon: "schedule" as const,
                  label: strings.clarifyLater, onClick: () => runCommand("task.deferClarification") }] : []),
                { key: "structure", icon: "split", label: strings.actionTileLabels["task.structure"], onClick: () => runCommand("task.structure") },
                ...(!isReference && !taskIsCapturedInboxItem && task.projectId !== null ? [{
                  key: "additional", icon: "actionable" as const,
                  label: task.additionalNextAction ? strings.unmarkAdditionalNextAction : strings.markAdditionalNextAction,
                  onClick: () => { void dispatch({ type: "task.toggleAdditionalNextAction", task }); },
                }] : []),
                { key: "attachment", icon: "attachment", label: strings.attach, onClick: () => setAttachmentOpen(true) },
              ]}>
            <NativeShareButton showLabel
              title={task.title}
              text={serializeTaskForShare(task, locale)}
              url={buildTaskShareUrl(task.id)}
              showStatus
            />
            <CalendarExportButton showLabel
              item={{
                kind: "task",
                id: task.id,
                title: task.title,
                notes: task.notes,
                dueDate: task.dueDate,
              }}
              showStatus
            />

              <button type="button" className="btn btn-danger detail-menu-danger" disabled={deleting || taskMutationPending} onClick={() => setConfirmingDelete(true)}>{strings.delete}</button>
            </DetailActionMenu>
          </>
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
          <div className="field task-detail-title-field" ref={titleFieldRef}>
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
                {!isReference && !taskIsCapturedInboxItem ? <button type="button"
                  className="detail-complete-trigger"
                  aria-label={task.status === "done" || task.status === "cancelled" ? strings.reopen : strings.done}
                  onClick={() => dispatch({ type: "task.toggleDone", task })}>
                  <span aria-hidden="true" className={`task-row-checkbox${task.status === "done" ? " done" : ""}${task.status === "cancelled" ? " cancelled" : ""}`}>{task.status === "done" ? "✓" : task.status === "cancelled" ? "×" : ""}</span>
                </button> : null}
                <h1>
                  {task.title}
                </h1>
                  <IconActionButton
                    kind="edit"
                    label={strings.edit}
                    onClick={() => setTitleEditing(true)}
                  />
              </div>
            )}
          </div>
          <ExternalRefBadge refs={loadedTask?.externalRefs ?? []} />


          {isReference ? (
            <div className="task-detail-reference-header">
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
                </span>
              ) : null}
              {referenceContent?.primaryWebLink ? (
                <a
                  href={referenceContent.primaryWebLink.url}
                  target="_blank"
                  rel="noreferrer"
                  className="task-row-reference-link"
                >
                  {referenceContent.primaryWebLink.label} ↗
                </a>
              ) : null}
              <button
                type="button"
                className="btn btn-sm"
                disabled={makeActionBusy || taskMutationPending}
                onClick={() => {
                  setMakeActionError(null);
                  setMakeActionBusy(true);
                  void taskActions
                    .makeAction(task)
                    .catch((cause) => {
                      setMakeActionError(localizedErrorMessage(cause, strings));
                    })
                    .finally(() => setMakeActionBusy(false));
                }}
              >
                {strings.makeAction}
              </button>
              {makeActionError ? (
                <WorkItemInlineError message={makeActionError} />
              ) : null}
            </div>
          ) : null}

          <div className="detail-summary">
            {!isReference ? <div className="detail-summary-status">
              <StatusBadge status={task.status} {...(taskIsCapturedInboxItem ? {} : { onClick: () => runCommand("task.lifecycle") })} />
            </div> : null}
            {!isReference ? <div className="detail-summary-group detail-meta-row" aria-label={strings.detailResponsibility}>
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
                label={strings.detailResponsibility}
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
            {task.parentTaskId === null && task.projectId === null ? (
              <DetailPropertyPill
                label={strings.detailScope}
                onClick={async () => {
                  setSaveError(null);
                  try {
                    await taskActions.update(
                      task,
                      {
                        scope: task.scope === "work" ? "household" : "work",
                        expectedRevision: task.revision,
                      },
                      undefined,
                      true,
                    );
                  } catch (cause) {
                    if (isStaleWriteConflict(cause)) reload();
                    setSaveError(localizedErrorMessage(cause, strings));
                  }
                }}
              >
                <span>
                  {task.scope === "work" ? strings.scopeWork : strings.scopeHousehold}
                </span>
              </DetailPropertyPill>
            ) : null}

            </div> : null}
            {!isReference ? <>
              <div className="detail-summary-group detail-meta-row" aria-label={strings.planning}>
                <DetailPropertyPill label={task.scheduledDate ? strings.detailPlanned : undefined}
                  variant={task.scheduledDate ? "set" : "unset"}
                  onClick={() => dispatch({ type: "task.plan", taskId: task.id, target: "scheduled" })}>
                  {task.scheduledDate ? localDate(task.scheduledDate) : strings.addPlan}
                </DetailPropertyPill>
                <DetailPropertyPill label={task.dueDate ? strings.due : undefined}
                  variant={task.dueDate ? "set" : "unset"}
                  onClick={() => dispatch({ type: "task.plan", taskId: task.id, target: "deadline" })}>
                  {task.dueDate ? localDate(task.dueDate) : strings.addDeadline}
                </DetailPropertyPill>
                {revisitAtValue ? <DetailPropertyPill label={strings.detailShowAgain} onClick={() => runCommand("task.availability")}>{revisitAtValue}</DetailPropertyPill> : null}
                {task.availabilityRule ? <DetailPropertyPill label={strings.availabilityWindow} onClick={() => runCommand("task.availability")}>
                  {task.availabilityRule.match === "inside" ? strings.availabilityBusinessHours : strings.availabilityOutsideBusinessHours}
                </DetailPropertyPill> : null}
                {task.reminders.length > 0 && reminderSummary ? <DetailPropertyPill label={strings.detailReminder} onClick={() => runCommand("task.reminders")}>
                  {reminderSummary.label}{reminderSummary.overflowCount > 0 ? ` +${reminderSummary.overflowCount}` : ""}
                </DetailPropertyPill> : null}
                {task.externalWait ? <DetailPropertyPill label={strings.waitingFor} onClick={() => runCommand("task.waitingLifecycle")}>{waitValue || strings.waiting}</DetailPropertyPill> : null}
                {task.repeatAfterDays !== null ? <DetailPropertyPill onClick={() => runCommand("task.recurrence")}>
                  {strings.detailRecurrence(task.repeatAfterDays)}
                </DetailPropertyPill> : null}
              </div>
              {task.priority !== null || task.dependencies.length > 0 ? <div className="detail-summary-group detail-meta-row">
                {task.priority !== null ? <DetailPropertyPill label={strings.priority} onClick={() => runCommand("task.priority")}>
                  {strings.detailPriorityNames[String(task.priority) as keyof typeof strings.detailPriorityNames] ?? task.priority}
                </DetailPropertyPill> : null}
                {task.dependencies.length > 0 ? <DetailPropertyPill label={strings.detailPrerequisites}
                  onClick={() => dispatch({ type: "task.plan", taskId: task.id, target: "dependencies" })}>
                  {task.dependencies.map((dep) => dep.title ?? `#${dep.dependsOnTaskId}`).join(" · ")}
                </DetailPropertyPill> : null}
              </div> : null}
            </> : null}
            <div className="detail-summary-group detail-shortcuts detail-meta-row">
              <DetailPropertyPill ariaLabel={task.effectiveTags.length ? `${strings.tags}: ${task.effectiveTags.map((tag) => tag.name).join(", ")}` : undefined} variant={task.effectiveTags.length ? "set" : "unset"} onClick={() => runCommand("task.tags")}>
                {task.effectiveTags.length ? <>{strings.tags}: {task.effectiveTags.map((tag) => <span key={tag.id}>{tag.name}</span>)}</> : strings.addTags}
              </DetailPropertyPill>
              <DetailPropertyPill ariaLabel={task.effectiveContexts.length ? `${strings.physicalContexts}: ${task.effectiveContexts.map((context) => context.name).join(", ")}` : undefined} variant={task.effectiveContexts.length ? "set" : "unset"} onClick={() => runCommand("task.contexts")}>
                {task.effectiveContexts.length ? <>{strings.physicalContexts}: {task.effectiveContexts.map((context) => <span key={context.id}>{context.name}</span>)}</> : strings.addContexts}
              </DetailPropertyPill>
              {!isReference ? <DetailActionMenu label={strings.detailMoreOptions} resetKey={task.id} items={[
                ...(!revisitAtValue ? [{ key: "revisit", icon: "schedule" as const, label: strings.detailAddRevisit, onClick: () => runCommand("task.availability") }] : []),
                ...(!task.reminders.length ? [{ key: "reminder", icon: "today" as const, label: strings.detailAddReminder, onClick: () => runCommand("task.reminders") }] : []),
                ...(!task.externalWait ? [{ key: "wait", icon: "waiting" as const, label: strings.detailAddWait, onClick: () => runCommand("task.waitingLifecycle") }] : []),
                ...(task.repeatAfterDays === null ? [{ key: "recurrence", icon: "recurrence" as const, label: strings.detailAddRecurrence, onClick: () => runCommand("task.recurrence") }] : []),
                ...(task.priority === null ? [{ key: "priority", icon: "priority" as const, label: strings.detailAddPriority, onClick: () => runCommand("task.priority") }] : []),
                ...(!task.dependencies.length ? [{ key: "dependencies", icon: "criteria" as const, label: strings.detailAddPrerequisites, onClick: () => dispatch({ type: "task.plan", taskId: task.id, target: "dependencies" }) }] : []),
              ]} /> : null}
            </div>
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

          <section className={`section task-notes-section${!task.notes && !notesEditing ? " detail-empty-content" : ""}`}>
            <div className="row-between">
              <h2 className="section-title" id="task-notes-label">{strings.notes}</h2>
              {!notesEditing ? (
                <IconActionButton
                  kind="edit"
                  label={strings.edit}
                  disabled={taskActions.isPending(task.id)}
                  onClick={() => setNotesEditing(true)}
                />
              ) : null}
            </div>
            <NotesAppend disabled={notesEditing || savingTextFields || taskMutationPending} onAppend={async content => {
              const updated = await taskActions.appendNotes(task, content);
              if (updated) { revisionRef.current = updated.revision; setTextFieldsBaseline(current => current ? { ...current, notes: updated.notes } : current); setNotesDraft(updated.notes); }
              return updated;
            }} />
            {notesEditing ? (
              <>
                <label className="sr-only" id="task-notes-label">{strings.notes}</label>
                <MarkdownEditor
                  disabled={savingTextFields || taskMutationPending}
                  id="task-notes"
                  aria-label={strings.notes}
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

          {!isReference && task.acceptanceCriteria.length > 0 ? (
            <WorkItemDetailDisclosure
              title={strings.taskCriteria}
              summary={strings.taskCriteriaSummary(
                task.acceptanceCriteria.filter((criterion) => criterion.checked).length,
                task.acceptanceCriteria.length,
              )}
              defaultOpen
              resetKey={task.id}
            >
              {criteriaError ? <p role="alert" className="capture-error">{criteriaError}</p> : null}
              <AcceptanceCriteriaEditor
                ownerType="task"
                workItemId={task.id}
                criteria={task.acceptanceCriteria}
                onError={setCriteriaError}
              />
            </WorkItemDetailDisclosure>
          ) : null}

          <WorkItemDetailDisclosure
            title={loadedTask?.childStories?.length ? strings.structure : strings.subtasks}
            summary={
              loadedTask?.childStories?.length
                ? strings.projects
                : task.children.length > 0
                  ? strings.subtaskSummary(task.children.length)
                  : undefined
            }
            defaultOpen={task.children.length > 0 || (loadedTask?.childStories?.length ?? 0) > 0}
            resetKey={task.id}
            className={!task.children.length && !loadedTask?.childStories?.length ? "detail-empty-content" : ""}
          >
            <div className="field">
            <ul className="list" style={{ padding: 0, margin: 0 }}>
              {[
                ...task.children.map((item) => ({ role: "task" as const, item })),
                ...(loadedTask?.childStories ?? []).map((item) => ({ role: "story" as const, item })),
              ].sort((a, b) => a.item.position - b.item.position).map((entry) => {
                if (entry.role === "story") return (
                  <li key={entry.item.id} className="row-between">
                    <button type="button" className="btn" onClick={() => dispatch({ type: "workItem.open", workItem: { id: entry.item.id, role: "story" } })}>📁 {entry.item.title}</button>
                  </li>
                );
                const child = entry.item;
                return (
                  <li key={child.id} className="row-between">
                    <span className="row">
                      {child.kind === "reference" ? (
                        <span className="task-row-checkbox task-row-reference-glyph" aria-hidden="true">
                          🗎
                        </span>
                      ) : (
                        <button
                          type="button"
                          className={`task-row-checkbox${child.status === "done" ? " done" : ""}${child.status === "cancelled" ? " cancelled" : ""}`}
                          aria-label={child.status === "done" || child.status === "cancelled" ? strings.reopen : strings.done}
                          onClick={() => {
                            dispatch({ type: "task.toggleDone", task: child });
                            reload();
                          }}
                        >
                          {child.status === "done" ? "✓" : child.status === "cancelled" ? "×" : ""}
                        </button>
                      )}
                      <button type="button" className="link-plain" onClick={() => open(child.id)}>
                        {child.title}
                      </button>
                    </span>
                    {child.kind === "reference" ? null : <StatusBadge status={child.status} />}
                  </li>
                );
              })}
            </ul>
            {!isReference && task.repeatAfterDays === null && !taskIsCapturedInboxItem ? (
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

          {!isReference ? (
          <WorkItemDetailDisclosure
            title={strings.dependencies}
            summary={
              unresolvedDependencyCount > 0
                ? strings.dependencySummary(unresolvedDependencyCount)
                : undefined
            }
            defaultOpen={task.dependencies.length > 0}
            className={!task.dependencies.length ? "detail-empty-content" : ""}
            forceOpen={focusField === "dependencies"}
            resetKey={task.id}
          >
            <div className="stack blocker-control" ref={dependenciesFieldRef}>
              <ul className="list" style={{ padding: 0, margin: 0 }}>
                {sortDependencies(task.dependencies, locale).map((dep) => (
                  <li key={dep.id} className="row-between">
                    <span>{dep.title ?? `#${dep.dependsOnTaskId}`}</span>
                    <span className="text-muted">
                      {dep.resolved ? strings.resolved : strings.unresolved}
                    </span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => dispatch({ type: "task.plan", taskId: task.id, target: "dependencies" })}
              >
                {strings.editPrerequisites}
              </button>
            </div>
          </WorkItemDetailDisclosure>
          ) : null}



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
          >
          <p className="text-muted task-detail-metadata">
            {strings.created}: {formatDateTime(task.createdAt, locale)} ·{" "}
            {strings.updated}: {formatDateTime(task.updatedAt, locale)}
          </p>
          </RecentActivity>


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
            notesRef.current?.insertMarkdown(markdown);
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

    </>
  );
}
