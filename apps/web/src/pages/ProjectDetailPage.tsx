import { useCallback, useEffect, useRef, useState } from "react";
import {
  useParams,
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import { LoadingState, ErrorState } from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { ProjectStoryRow } from "../components/ProjectStoryRow";
import { QuickAdd } from "../components/QuickAdd";
import { countTasks, flattenTasks } from "../lib/taskHelpers";
import { useIdentity } from "../lib/identity";
import { formatDate } from "../lib/format";
import { ProjectStuckNotice } from "../components/ProjectStuckNotice";
import { MarkdownNotes } from "../components/MarkdownNotes";
import { NativeShareButton } from "../components/NativeShareButton";
import { CalendarExportButton } from "../components/CalendarExportButton";
import { serializeProjectForShare } from "../lib/shareText";
import { buildProjectShareUrl } from "../lib/shareUrls";
import { PageHeader } from "../components/PageHeader";
import { MemberLabel } from "../components/MemberAvatar";
import { IconActionButton } from "../components/IconActionButton";
import { TaskCardTags } from "../components/TaskCardTags";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useTaskDetail } from "../lib/taskDetailContext";
import { useProjectWorkflow } from "../lib/projectWorkflowContext";
import { RecentActivity } from "../components/RecentActivity";
import { useLocale } from "../lib/locale";
import { recordRecentlyViewed } from "../lib/recentlyViewed";
import type { ProjectWithActions } from "../lib/api";
import { useProjectActions } from "../lib/useProjectActions";
import { projectWorkflowLabel } from "../lib/projectWorkflow";
import { storyWorkflowCommand } from "../lib/commands";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { AcceptanceCriteriaChecklist } from "../components/AcceptanceCriteriaChecklist";
import { WorkItemDetailDisclosure } from "../components/WorkItemDetailSection";
import { ActionTileGrid } from "../components/ActionTileGrid";
import { appendTextBlock } from "../lib/shareTarget";
import {
  containsPaperlessReference,
  extractPaperlessReferences,
} from "../lib/paperlessAttachments";
import { MarkdownAttachmentSheet } from "../components/MarkdownAttachmentSheet";
import { PaperlessAttachmentStrip } from "../components/PaperlessAttachmentStrip";
import {
  isStaleWriteConflict,
  localizedErrorMessage,
} from "../lib/errorMessage";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { WorkItemKeyboardNavMount } from "../components/WorkItemKeyboardNavMount";
import { ProjectDeleteChoiceSheet } from "../components/ProjectDeleteChoiceSheet";

export function ProjectDetailPage() {
  const strings = useStrings();
  const { locale } = useLocale();
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const projectId = Number(params.id);
  const [searchParams, setSearchParams] = useSearchParams();
  const focus = searchParams.get("focus");
  const { members } = useIdentity();
  const [titleDraft, setTitleDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [titleEditing, setTitleEditing] = useState(false);
  const [notesEditing, setNotesEditing] = useState(false);
  const [savingContent, setSavingContent] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const contentBaselineRef = useRef<{
    id: number;
    title: string;
    notes: string;
  } | null>(null);
  const [confirmedProject, setConfirmedProject] =
    useState<ProjectWithActions | null>(null);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const planningTaskRef = useRef<number | null>(null);
  const storyFocusDispatchedRef = useRef<string | null>(null);
  const storyFocusSheetOpenedRef = useRef(false);
  const planningOwnsSheetRef = useRef(false);
  const planningSheetOpenedRef = useRef(false);
  const dispatch = useWorkItemCommands();
  const taskWorkflow = useTaskWorkflow();
  const { openTaskId } = useTaskDetail();
  const projectWorkflow = useProjectWorkflow();
  const projectWorkflowOpen = projectWorkflow.current?.projectId === projectId;
  const closeProjectWorkflowRef = useRef(projectWorkflow.close);
  closeProjectWorkflowRef.current = projectWorkflow.close;
  // `?focus=planning` is a deep link into the canonical `task.plan` workflow
  // for the project's first unplanned task; this page only decides *which*
  // task and cleans up after itself, it never implements planning.
  const planningWorkflowTaskId =
    taskWorkflow.current?.kind === "plan" ? taskWorkflow.current.taskId : null;
  const openTaskIdRef = useRef(planningWorkflowTaskId);
  const closeTaskDetailRef = useRef(taskWorkflow.close);
  openTaskIdRef.current = planningWorkflowTaskId;
  closeTaskDetailRef.current = taskWorkflow.close;
  const {
    data: loadedProject,
    loading: projectLoading,
    error: projectError,
    reload: reloadProject,
  } = useAsync(() => api.getProject(projectId), [projectId]);
  // Recency is a soft ranking boost for search/pickers, not domain state —
  // record it once per genuine open, not on every re-render/reload.
  useEffect(() => {
    if (Number.isFinite(projectId)) recordRecentlyViewed("project", projectId);
  }, [projectId]);
  useEffect(() => {
    setConfirmedProject((current) => {
      if (!current || current.id !== loadedProject?.id) return null;
      if (loadedProject.revision >= current.revision) return null;
      return current;
    });
  }, [loadedProject]);
  const project =
    loadedProject &&
    confirmedProject?.id === loadedProject.id &&
    confirmedProject.revision > loadedProject.revision
      ? { ...loadedProject, ...confirmedProject, tasks: loadedProject.tasks }
      : loadedProject;
  const projectActions = useProjectActions(
    loadedProject ? [loadedProject] : [],
  );
  const attachments = project ? extractPaperlessReferences(project.notes) : [];

  const owner = project
    ? members.find((m) => m.id === project.ownerMemberId)
    : undefined;
  const taskCounts = project ? countTasks(project.tasks) : { open: 0, done: 0 };
  const criteriaTotal = project?.acceptanceCriteria.length ?? 0;
  const criteriaDone =
    project?.acceptanceCriteria.filter((c) => c.checked).length ?? 0;
  const criteriaPct =
    criteriaTotal > 0 ? Math.round((criteriaDone / criteriaTotal) * 100) : 0;
  const dueDate = project ? formatDate(project.dueDate, locale) : null;
  const scheduledDate = project
    ? formatDate(project.scheduledDate, locale)
    : null;
  const hasProjectLabels =
    Boolean(project?.tags.length) || Boolean(project?.contexts.length);
  const hasProjectMeta =
    Boolean(owner) || Boolean(dueDate) || Boolean(scheduledDate) || hasProjectLabels;

  const reviewReturn = (
    location.state as {
      reviewReturn?: { issueKey: string; issueIndex: number };
    } | null
  )?.reviewReturn;

  // Authored text is the only thing this page edits itself; every scalar
  // property is a semantic command (see docs/architecture-rules.md).
  useEffect(() => {
    if (!project) return;
    const baseline = contentBaselineRef.current;
    if (baseline?.id !== project.id) {
      contentBaselineRef.current = {
        id: project.id,
        title: project.title,
        notes: project.notes,
      };
      setTitleDraft(project.title);
      setNotesDraft(project.notes);
      setTitleEditing(false);
      setNotesEditing(false);
      return;
    }
    contentBaselineRef.current = {
      id: project.id,
      title: project.title,
      notes: project.notes,
    };
    if (!titleEditing) setTitleDraft(project.title);
    if (!notesEditing) setNotesDraft(project.notes);
  }, [project, titleEditing, notesEditing]);

  const titleDirty = titleDraft !== (contentBaselineRef.current?.title ?? "");
  const notesDirty = notesDraft !== (contentBaselineRef.current?.notes ?? "");

  const saveContentField = async (field: "title" | "notes") => {
    if (!project || savingContent) return false;
    const value = field === "title" ? titleDraft.trim() : notesDraft;
    if (field === "title" && !value) return false;
    setSavingContent(true);
    setContentError(null);
    try {
      const confirmed = await projectActions.update(
        project,
        { [field]: value },
        { [field]: value },
        true,
      );
      if (!confirmed) return false;
      setConfirmedProject(confirmed);
      return true;
    } catch (cause) {
      if (isStaleWriteConflict(cause)) reloadProject();
      setContentError(localizedErrorMessage(cause, strings));
      return false;
    } finally {
      setSavingContent(false);
    }
  };

  const removeProject = async (deleteTasks: boolean) => {
    if (!project) return;
    setDeleting(true);
    setContentError(null);
    try {
      await api.deleteProject(project.id, { deleteTasks });
      setConfirmingDelete(false);
      navigate(reviewReturn ? "/more/review" : "/projects", {
        ...(reviewReturn ? { state: { reviewReturn } } : {}),
      });
    } catch (cause) {
      setContentError(localizedErrorMessage(cause, strings));
      setDeleting(false);
    }
  };

  const clearRouteFocus = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("focus");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const planningFocusActive = focus === "planning";

  useEffect(() => {
    if (!planningFocusActive) return;
    return () => {
      const ownedTaskId = planningTaskRef.current;
      const ownsPendingOpen =
        planningOwnsSheetRef.current &&
        !planningSheetOpenedRef.current &&
        openTaskIdRef.current === null;
      const ownsOpenSheet =
        planningOwnsSheetRef.current && openTaskIdRef.current === ownedTaskId;

      planningTaskRef.current = null;
      planningOwnsSheetRef.current = false;
      planningSheetOpenedRef.current = false;

      if (ownsPendingOpen || ownsOpenSheet) closeTaskDetailRef.current();
    };
  }, [planningFocusActive, projectId]);

  useEffect(() => {
    if (
      !planningFocusActive ||
      !project ||
      project.id !== projectId ||
      planningTaskRef.current !== null ||
      planningWorkflowTaskId !== null ||
      // A deep link must never displace a focused surface the user opened.
      openTaskId !== null
    ) {
      return;
    }
    const taskToPlan = flattenTasks(project.tasks).find(
      (task) =>
        task.status !== "done" &&
        task.status !== "cancelled" &&
        !task.dueDate &&
        !task.scheduledDate,
    );
    if (!taskToPlan) return;
    planningTaskRef.current = taskToPlan.id;
    planningOwnsSheetRef.current = true;
    planningSheetOpenedRef.current = false;
    dispatch({ type: "task.plan", taskId: taskToPlan.id });
  }, [
    planningFocusActive,
    project,
    projectId,
    planningWorkflowTaskId,
    openTaskId,
    dispatch,
  ]);

  useEffect(() => {
    const ownedTaskId = planningTaskRef.current;
    if (
      !planningFocusActive ||
      !planningOwnsSheetRef.current ||
      ownedTaskId === null
    )
      return;

    if (planningWorkflowTaskId === ownedTaskId) {
      planningSheetOpenedRef.current = true;
    } else if (planningSheetOpenedRef.current || planningWorkflowTaskId !== null) {
      planningOwnsSheetRef.current = false;
      clearRouteFocus();
    }
  }, [planningFocusActive, planningWorkflowTaskId, clearRouteFocus]);

  // Review repair links for the story itself are the same three intents the
  // rail and keyboard dispatch; the route only picks one and then cleans up
  // its query once the workflow it opened is gone.
  const storyFocusCommand =
    focus === "driver"
      ? ("story.assignDriver" as const)
      : focus === "outcome"
        ? ("story.editOutcome" as const)
        : focus === "completion"
          ? ("story.complete" as const)
          : null;

  useEffect(() => {
    if (
      storyFocusCommand === null ||
      !project ||
      project.id !== projectId ||
      storyFocusDispatchedRef.current === `${projectId}:${storyFocusCommand}`
    ) {
      return;
    }
    storyFocusDispatchedRef.current = `${projectId}:${storyFocusCommand}`;
    dispatch({ type: storyFocusCommand, story: project });
  }, [storyFocusCommand, project, projectId, dispatch]);

  useEffect(() => {
    if (
      storyFocusCommand === null ||
      storyFocusDispatchedRef.current !== `${projectId}:${storyFocusCommand}`
    ) {
      return;
    }
    if (projectWorkflowOpen) {
      storyFocusSheetOpenedRef.current = true;
      return;
    }
    // `story.complete` may commit without a sheet, so only treat a closed
    // workflow as "done" once it either opened or had nothing to open.
    storyFocusDispatchedRef.current = null;
    storyFocusSheetOpenedRef.current = false;
    clearRouteFocus();
  }, [storyFocusCommand, projectId, projectWorkflowOpen, clearRouteFocus]);

  useEffect(() => {
    if (storyFocusCommand === null) return;
    return () => {
      if (storyFocusSheetOpenedRef.current) closeProjectWorkflowRef.current();
      storyFocusDispatchedRef.current = null;
      storyFocusSheetOpenedRef.current = false;
    };
  }, [storyFocusCommand, projectId]);

  return (
    <InteractionScopeProvider
      captureTarget={{ kind: "story", storyId: projectId }}
    >
      <WorkItemKeyboardNavMount />
      <div>
        <Link
          to={reviewReturn ? "/more/review" : "/projects"}
          state={reviewReturn ? { reviewReturn } : undefined}
          className="link-plain"
        >
          ← {reviewReturn ? strings.reviewTitle : strings.projects}
        </Link>
        {project?.ancestors?.length ? (
          <nav className="row text-muted" aria-label="Breadcrumb">
            {project.ancestors.map((ancestor, index) => (
              <span key={ancestor.id} className="row">
                {index > 0 ? <span aria-hidden="true">›</span> : null}
                <Link to={`/projects/${ancestor.id}`} className="link-plain">
                  {ancestor.title}
                </Link>
              </span>
            ))}
          </nav>
        ) : null}
        {projectLoading ? <LoadingState /> : null}
        {projectError ? (
          <ErrorState message={projectError} onRetry={reloadProject} />
        ) : null}
        {project ? (
          <>
            <div className="page-header project-page-header">
              <div className="row-between project-page-title-row">
                {titleEditing ? (
                  <div className="field project-title-field">
                    <label className="sr-only" htmlFor="project-title">
                      {strings.projectTitle}
                    </label>
                    <input
                      id="project-title"
                      value={titleDraft}
                      autoFocus
                      onChange={(event) => setTitleDraft(event.target.value)}
                    />
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={savingContent}
                        onClick={() => {
                          setTitleDraft(project.title);
                          setTitleEditing(false);
                        }}
                      >
                        {strings.cancel}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={
                          !titleDirty || !titleDraft.trim() || savingContent
                        }
                        onClick={() =>
                          void saveContentField("title").then((saved) => {
                            if (saved) setTitleEditing(false);
                          })
                        }
                      >
                        {strings.save}
                      </button>
                    </div>
                  </div>
                ) : (
                  <h1>
                    {project.title}
                    <IconActionButton
                      kind="edit"
                      label={strings.edit}
                      onClick={() => setTitleEditing(true)}
                    />
                  </h1>
                )}
                <div className="row project-page-actions">
                  <NativeShareButton
                    title={project.title}
                    text={serializeProjectForShare(project, locale)}
                    url={buildProjectShareUrl(project.id)}
                  />
                  <CalendarExportButton
                    item={{
                      kind: "project",
                      id: project.id,
                      title: project.title,
                      notes: project.notes,
                      dueDate: project.dueDate,
                    }}
                  />
                  <IconActionButton
                    kind="attachment"
                    label={strings.attach}
                    disabled={projectActions.isPending(project.id)}
                    onClick={() => {
                      setAttachmentError(null);
                      setAttachmentOpen(true);
                    }}
                  />
                </div>
              </div>
              <div
                className="project-detail-overview"
                aria-label={strings.projectOverview}
              >
                <div className="project-detail-overview-row">
                  <span className="sr-only">{strings.projectStatus}: </span>
                  <button
                    type="button"
                    className={`badge badge-button project-detail-status-badge project-detail-status-badge-${project.status}`}
                    onClick={() => setLifecycleOpen((current) => !current)}
                  >
                    {strings.projectStatusLabels[project.status]}
                  </button>
                  <span className="project-detail-task-progress">
                    {strings.taskProgress}: {taskCounts.open}{" "}
                    {strings.openTasks.toLowerCase()} · {taskCounts.done}{" "}
                    {strings.doneTasks.toLowerCase()}
                  </span>
                </div>
                {lifecycleOpen ? (
                  <div
                    className="story-row-lifecycle"
                    role="group"
                    aria-label={strings.status}
                  >
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled
                      aria-current="true"
                    >
                      {strings.projectStatusLabels[project.status]}
                    </button>
                    {project.availableActions.map((action) => (
                      <button
                        key={action}
                        type="button"
                        className="btn btn-sm"
                        disabled={projectActions.isPending(project.id)}
                        data-workflow-action={action}
                        onClick={() => {
                          setLifecycleOpen(false);
                          dispatch(storyWorkflowCommand(project, action));
                        }}
                      >
                        {projectWorkflowLabel(action, strings)}
                      </button>
                    ))}
                  </div>
                ) : null}
                {hasProjectMeta ? (
                  <div className="detail-meta-row">
                    {owner ? (
                      <button
                        type="button"
                        className="detail-meta-button"
                        onClick={() => dispatch({ type: "story.assignDriver", story: project })}
                      >
                        <span className="detail-meta-label">
                          {strings.driver}
                        </span>
                        <MemberLabel member={owner} size="xs" />
                      </button>
                    ) : null}
                    {dueDate ? (
                      <button
                        type="button"
                        className="detail-meta-button"
                        onClick={() =>
                          dispatch({ type: "story.planDates", story: project })
                        }
                      >
                        <span className="detail-meta-label">
                          {strings.due}
                        </span>
                        <span>{dueDate}</span>
                      </button>
                    ) : null}
                    {scheduledDate ? (
                      <button
                        type="button"
                        className="detail-meta-button"
                        onClick={() =>
                          dispatch({ type: "story.planDates", story: project })
                        }
                      >
                        <span className="detail-meta-label">
                          {strings.projectRevisitDate}
                        </span>
                        <span>{scheduledDate}</span>
                      </button>
                    ) : null}
                    {hasProjectLabels ? (
                      <button
                        type="button"
                        className="detail-meta-button project-detail-label-button"
                        aria-label={
                          project.contexts.length > 0 && project.tags.length === 0
                            ? strings.physicalContexts
                            : strings.tags
                        }
                        onClick={() =>
                          dispatch({
                            type:
                              project.contexts.length > 0 &&
                              project.tags.length === 0
                                ? "story.contexts"
                                : "story.tags",
                            story: project,
                          })
                        }
                      >
                        <span className="detail-meta-label">
                          {project.contexts.length > 0
                            ? strings.cardLabels
                            : strings.tags}
                        </span>
                        <TaskCardTags
                          tags={project.tags}
                          contexts={project.contexts}
                        />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            <PaperlessAttachmentStrip attachments={attachments} />
            {attachmentError ? (
              <p className="capture-error" role="alert">
                {attachmentError}
              </p>
            ) : null}
            {project.stuckReason ? (
              <ProjectStuckNotice reason={project.stuckReason} />
            ) : null}
            {contentError ?? projectActions.errors[project.id] ? (
              <p className="capture-error" role="alert">
                {contentError ?? projectActions.errors[project.id]}
              </p>
            ) : null}
            <section className="section project-notes-section">
              <div className="row-between">
                <h2 className="section-title" id="project-notes-label">
                  {strings.notes}
                </h2>
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
                    id="project-notes"
                    value={notesDraft}
                    onChange={setNotesDraft}
                    toolbarLabel={strings.markdownToolbar}
                    rows={6}
                  />
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={savingContent}
                      onClick={() => {
                        setNotesDraft(project.notes);
                        setNotesEditing(false);
                      }}
                    >
                      {strings.cancel}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={!notesDirty || savingContent}
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
            <section className="section project-outcome-section">
              <div className="row-between">
                <h2 className="section-title" id="project-outcome-label">
                  {strings.outcomeSectionTitle}
                  {criteriaTotal > 0 ? (
                    <span className="project-outcome-count">
                      {" "}
                      {strings.outcomeSectionCount(criteriaDone, criteriaTotal)}
                    </span>
                  ) : null}
                </h2>
                <IconActionButton
                  kind="criteria"
                  label={strings.actionTileLabels["story.editOutcome"]}
                  onClick={() => dispatch({ type: "story.editOutcome", story: project })}
                />
              </div>
              {criteriaTotal > 0 ? (
                <span className="criteria-progress" aria-hidden="true">
                  <span style={{ width: `${criteriaPct}%` }} />
                </span>
              ) : null}
              <AcceptanceCriteriaChecklist
                projectId={project.id}
                criteria={project.acceptanceCriteria}
              />
            </section>
            <section className="section">
              <PageHeader
                title={strings.taskSummary}
                headingLevel={2}
                hints={[{ text: strings.projectTasksHint }]}
              />
              {project.childStories?.length ? (
                <ul className="project-story-list">
                  {project.childStories.map((story) => (
                    <ProjectStoryRow key={story.id} story={story} />
                  ))}
                </ul>
              ) : null}
              <TaskOutline
                tasks={project.tasks}
                emptyMessage={strings.noTasks}
                organizable
                showSwipeHint={false}
                nextActionInfo={{
                  canonicalId: project.nextAction?.id ?? null,
                  additionalSelectedIds: new Set(
                    (project.additionalNextActions ?? []).map((t) => t.id),
                  ),
                }}
              />
            </section>
            <WorkItemDetailDisclosure
              title={strings.moreActions}
              resetKey={project.id}
              className="project-detail-commands"
            >
              <ActionTileGrid
                items={[
                  {
                    key: "story.planWork",
                    icon: "successor",
                    label: strings.actionTileLabels["story.planWork"],
                    onClick: () => dispatch({ type: "story.planWork", story: project }),
                  },
                  {
                    key: "story.assignDriver",
                    icon: "owner",
                    label: strings.actionTileLabels["story.assignDriver"],
                    onClick: () => dispatch({ type: "story.assignDriver", story: project }),
                  },
                  {
                    key: "story.planDates",
                    icon: "schedule",
                    label: strings.actionTileLabels["story.planDates"],
                    onClick: () => dispatch({ type: "story.planDates", story: project }),
                  },
                  {
                    key: "story.defer",
                    icon: "followUp",
                    label: strings.actionTileLabels["story.defer"],
                    onClick: () => dispatch({ type: "story.defer", story: project }),
                  },
                  {
                    key: "story.editOutcome",
                    icon: "criteria",
                    label: strings.actionTileLabels["story.editOutcome"],
                    onClick: () => dispatch({ type: "story.editOutcome", story: project }),
                  },
                  {
                    key: "story.tags",
                    icon: "tags",
                    label: strings.actionTileLabels["story.tags"],
                    onClick: () => dispatch({ type: "story.tags", story: project }),
                  },
                  {
                    key: "story.contexts",
                    icon: "places",
                    label: strings.actionTileLabels["story.contexts"],
                    onClick: () => dispatch({ type: "story.contexts", story: project }),
                  },
                ]}
              />
            </WorkItemDetailDisclosure>
            <RecentActivity
              key={`project-activity-${project.id}`}
              filters={{ projectId: project.id }}
              idPrefix={`project-${project.id}-activity`}
            />
            <WorkItemDetailDisclosure
              title={strings.projectDangerSection}
              resetKey={project.id}
            >
              <button
                type="button"
                className="btn btn-danger"
                disabled={deleting}
                onClick={() => setConfirmingDelete(true)}
              >
                {strings.deleteProject}
              </button>
            </WorkItemDetailDisclosure>
          </>
        ) : null}
        {confirmingDelete && project ? (
          <ProjectDeleteChoiceSheet
            projectTitle={project.title}
            busy={deleting}
            onChoose={(deleteTasks) => void removeProject(deleteTasks)}
            onClose={() => setConfirmingDelete(false)}
          />
        ) : null}
        <QuickAdd
          autoOpen={focus === "next-action"}
          onAutoOpenClose={clearRouteFocus}
        />
        {attachmentOpen && project ? (
          <MarkdownAttachmentSheet
            onClose={() => setAttachmentOpen(false)}
            onInsert={async (markdown) => {
              if (containsPaperlessReference(project.notes, markdown)) return;
              const nextNotes = appendTextBlock(project.notes, markdown);
              setAttachmentError(null);
              try {
                const updated = await projectActions.update(
                  project,
                  { notes: nextNotes },
                  { notes: nextNotes },
                  true,
                );
                if (updated) setConfirmedProject(updated);
              } catch (cause) {
                if (isStaleWriteConflict(cause)) reloadProject();
                setAttachmentError(localizedErrorMessage(cause, strings));
                throw cause;
              }
            }}
          />
        ) : null}
      </div>
    </InteractionScopeProvider>
  );
}
