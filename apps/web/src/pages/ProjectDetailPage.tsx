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
import { ProjectEditSheet } from "../components/ProjectEditSheet";
import type { ProjectEditFocusField } from "../components/ProjectEditSheet";
import { countTasks, flattenTasks } from "../lib/taskHelpers";
import { useIdentity } from "../lib/identity";
import { formatDate } from "../lib/format";
import { ProjectStuckNotice } from "../components/ProjectStuckNotice";
import { TaskSequenceSheet } from "../components/TaskSequenceSheet";
import { MarkdownNotes } from "../components/MarkdownNotes";
import { NativeShareButton } from "../components/NativeShareButton";
import { CalendarExportButton } from "../components/CalendarExportButton";
import { serializeProjectForShare } from "../lib/shareText";
import { buildProjectShareUrl } from "../lib/shareUrls";
import { PageHeader } from "../components/PageHeader";
import { MemberLabel } from "../components/MemberAvatar";
import { IconActionButton } from "../components/IconActionButton";
import { StoryCriteriaSheet } from "../components/StoryCriteriaSheet";
import { MemberSelectionSheet } from "../components/MemberSelectionSheet";
import { PlanDatesSheet } from "../components/PlanDatesSheet";
import { ProjectTagsSheet } from "../components/ProjectTagsSheet";
import { TaskCardTags } from "../components/TaskCardTags";
import { useTaskDetail } from "../lib/taskDetailContext";
import { RecentActivity } from "../components/RecentActivity";
import { useLocale } from "../lib/locale";
import type { ProjectWithActions } from "../lib/api";
import { useProjectActions } from "../lib/useProjectActions";
import { canClearDriver } from "../lib/projectWorkflow";
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
  const [editing, setEditing] = useState(false);
  const [editingOutcome, setEditingOutcome] = useState(false);
  const [detailSheet, setDetailSheet] = useState<
    "driver" | "dates" | "tags" | null
  >(null);
  const [editFocusField, setEditFocusField] = useState<
    ProjectEditFocusField | undefined
  >();
  const [addingSequence, setAddingSequence] = useState(false);
  const [confirmedProject, setConfirmedProject] =
    useState<ProjectWithActions | null>(null);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const planningTaskRef = useRef<number | null>(null);
  const planningOwnsSheetRef = useRef(false);
  const planningSheetOpenedRef = useRef(false);
  const {
    openTaskId,
    open: openTaskDetail,
    close: closeTaskDetail,
  } = useTaskDetail();
  const openTaskIdRef = useRef(openTaskId);
  const closeTaskDetailRef = useRef(closeTaskDetail);
  openTaskIdRef.current = openTaskId;
  closeTaskDetailRef.current = closeTaskDetail;
  const {
    data: loadedProject,
    loading: projectLoading,
    error: projectError,
    reload: reloadProject,
  } = useAsync(() => api.getProject(projectId), [projectId]);
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
    Boolean(owner) ||
    Boolean(dueDate) ||
    Boolean(scheduledDate) ||
    hasProjectLabels ||
    criteriaTotal > 0;

  const clearRouteFocus = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("focus");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const planningFocusActive = focus === "planning";
  const reviewReturn = (
    location.state as {
      reviewReturn?: { issueKey: string; issueIndex: number };
    } | null
  )?.reviewReturn;

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
    openTaskDetail(taskToPlan.id, "schedule");
  }, [planningFocusActive, project, projectId, openTaskId, openTaskDetail]);

  useEffect(() => {
    const ownedTaskId = planningTaskRef.current;
    if (
      !planningFocusActive ||
      !planningOwnsSheetRef.current ||
      ownedTaskId === null
    )
      return;

    if (openTaskId === ownedTaskId) {
      planningSheetOpenedRef.current = true;
    } else if (planningSheetOpenedRef.current || openTaskId !== null) {
      planningOwnsSheetRef.current = false;
      clearRouteFocus();
    }
  }, [planningFocusActive, openTaskId, clearRouteFocus]);

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
                <h1>{project.title}</h1>
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
                  <IconActionButton
                    kind="edit"
                    label={strings.edit}
                    onClick={() => {
                      setEditFocusField(undefined);
                      setEditing(true);
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
                  <span className="badge project-detail-status-badge">
                    {strings.projectStatusLabels[project.status]}
                  </span>
                  <span className="project-detail-task-progress">
                    {strings.taskProgress}: {taskCounts.open}{" "}
                    {strings.openTasks.toLowerCase()} · {taskCounts.done}{" "}
                    {strings.doneTasks.toLowerCase()}
                  </span>
                </div>
                {hasProjectMeta ? (
                  <div className="project-detail-meta-row">
                    {owner ? (
                      <button
                        type="button"
                        className="project-detail-meta-button"
                        onClick={() => setDetailSheet("driver")}
                      >
                        <span className="project-detail-meta-label">
                          {strings.driver}
                        </span>
                        <MemberLabel member={owner} size="xs" />
                      </button>
                    ) : null}
                    {dueDate ? (
                      <button
                        type="button"
                        className="project-detail-meta-button"
                        onClick={() => setDetailSheet("dates")}
                      >
                        <span className="project-detail-meta-label">
                          {strings.due}
                        </span>
                        <span>{dueDate}</span>
                      </button>
                    ) : null}
                    {scheduledDate ? (
                      <button
                        type="button"
                        className="project-detail-meta-button"
                        onClick={() => setDetailSheet("dates")}
                      >
                        <span className="project-detail-meta-label">
                          {strings.projectRevisitDate}
                        </span>
                        <span>{scheduledDate}</span>
                      </button>
                    ) : null}
                    {hasProjectLabels ? (
                      <button
                        type="button"
                        className="project-detail-meta-button project-detail-label-button"
                        onClick={() => {
                          if (project.contexts.length > 0) {
                            setEditFocusField("planning");
                            setEditing(true);
                          } else {
                            setDetailSheet("tags");
                          }
                        }}
                      >
                        <span className="project-detail-meta-label">
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
                    {criteriaTotal > 0 ? (
                      <button
                        type="button"
                        className="project-detail-meta-button project-detail-criteria-button"
                        onClick={() => setEditingOutcome(true)}
                      >
                        <span>
                          {strings.criteria}: {criteriaDone}/{criteriaTotal}
                        </span>
                        <span className="criteria-progress" aria-hidden="true">
                          <span style={{ width: `${criteriaPct}%` }} />
                        </span>
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
            <section className="section project-notes-section">
              <div className="row-between">
                <h2 className="section-title">{strings.notes}</h2>
                <IconActionButton
                  kind="edit"
                  label={strings.edit}
                  onClick={() => {
                    setEditFocusField("notes");
                    setEditing(true);
                  }}
                />
              </div>
              {project.notes.trim() ? (
                <MarkdownNotes value={project.notes} />
              ) : (
                <p className="text-muted">{strings.noNotes}</p>
              )}
            </section>
            <section className="section">
              <PageHeader
                title={strings.taskSummary}
                headingLevel={2}
                actions={
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setAddingSequence(true)}
                  >
                    {strings.addSequence}
                  </button>
                }
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
              />
            </section>
            <RecentActivity
              key={`project-activity-${project.id}`}
              filters={{ projectId: project.id }}
              idPrefix={`project-${project.id}-activity`}
            />
          </>
        ) : null}
        <QuickAdd
          autoOpen={focus === "next-action"}
          onAutoOpenClose={clearRouteFocus}
        />
        {(editing || focus === "driver" || focus === "completion") &&
        project ? (
          <ProjectEditSheet
            project={project}
            onProjectConfirmed={setConfirmedProject}
            focusField={
              focus === "driver"
                ? "driver"
                : focus === "completion"
                  ? "completion"
                  : editFocusField
            }
            onClose={() => {
              setEditing(false);
              setEditFocusField(undefined);
              if (focus === "driver" || focus === "completion")
                clearRouteFocus();
            }}
            onDeleted={
              reviewReturn
                ? () =>
                    navigate("/more/review", {
                      state: { reviewReturn },
                    })
                : undefined
            }
          />
        ) : null}
        {(focus === "outcome" || editingOutcome) && project ? (
          <StoryCriteriaSheet
            story={project}
            onClose={() => {
              if (focus === "outcome") clearRouteFocus();
              setEditingOutcome(false);
            }}
          />
        ) : null}
        {detailSheet === "driver" && project ? (
          <MemberSelectionSheet
            title={strings.assignDriver}
            label={strings.driver}
            idPrefix={`project-detail-driver-${project.id}`}
            members={members}
            value={project.ownerMemberId}
            unassignedLabel={canClearDriver(project) ? strings.noDriver : null}
            hint={canClearDriver(project) ? undefined : strings.driverLockedHint}
            onClose={() => setDetailSheet(null)}
            onSelect={async (ownerMemberId) => {
              const confirmed = await projectActions.assignDriver(
                project,
                ownerMemberId,
              );
              if (confirmed) setConfirmedProject(confirmed);
            }}
          />
        ) : null}
        {detailSheet === "dates" && project ? (
          <PlanDatesSheet
            story={project}
            onClose={() => setDetailSheet(null)}
            onSave={async (patch) => {
              const confirmed = await projectActions.schedule(project, patch);
              if (confirmed) setConfirmedProject(confirmed);
            }}
          />
        ) : null}
        {detailSheet === "tags" && project ? (
          <ProjectTagsSheet
            story={project}
            onClose={() => setDetailSheet(null)}
            onSave={async (tagIds) => {
              const confirmed = await projectActions.update(
                project,
                { tagIds },
                undefined,
                true,
              );
              if (confirmed) setConfirmedProject(confirmed);
            }}
          />
        ) : null}
        {addingSequence ? (
          <TaskSequenceSheet
            projectId={projectId}
            onClose={() => setAddingSequence(false)}
          />
        ) : null}
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
