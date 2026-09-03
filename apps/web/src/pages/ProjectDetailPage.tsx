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
import { useTaskDetail } from "../lib/taskDetailContext";
import { RecentActivity } from "../components/RecentActivity";
import { useLocale } from "../lib/locale";
import type { ProjectWithActions } from "../lib/api";
import { useProjectActions } from "../lib/useProjectActions";
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
  const { openTaskId, open: openTaskDetail, close: closeTaskDetail } = useTaskDetail();
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
  const projectActions = useProjectActions(loadedProject ? [loadedProject] : []);
  const attachments = project
    ? extractPaperlessReferences(project.notes)
    : [];

  const owner = project ? members.find((m) => m.id === project.ownerMemberId) : undefined;
  const taskCounts = project ? countTasks(project.tasks) : { open: 0, done: 0 };
  const criteriaTotal = project?.acceptanceCriteria.length ?? 0;
  const criteriaDone = project?.acceptanceCriteria.filter((c) => c.checked).length ?? 0;
  const criteriaPct = criteriaTotal > 0 ? Math.round((criteriaDone / criteriaTotal) * 100) : 0;

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
    if (!planningFocusActive || !planningOwnsSheetRef.current || ownedTaskId === null) return;

    if (openTaskId === ownedTaskId) {
      planningSheetOpenedRef.current = true;
    } else if (planningSheetOpenedRef.current || openTaskId !== null) {
      planningOwnsSheetRef.current = false;
      clearRouteFocus();
    }
  }, [planningFocusActive, openTaskId, clearRouteFocus]);

  return (
    <div>
      <Link
        to={reviewReturn ? "/more/review" : "/projects"}
        state={reviewReturn ? { reviewReturn } : undefined}
        className="link-plain"
      >
        ← {reviewReturn ? strings.reviewTitle : strings.projects}
      </Link>
      {projectLoading ? <LoadingState /> : null}
      {projectError ? <ErrorState message={projectError} onRetry={reloadProject} /> : null}
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
            <div className="row text-muted" style={{ fontSize: "0.8rem" }}>
              <span className="badge">{strings.projectStatusLabels[project.status]}</span>
              <span className="member-label">
                <span>{strings.driver}:</span>
                {owner ? (
                  <MemberLabel member={owner} size="xs" />
                ) : (
                  strings.noDriver
                )}
              </span>
              {project.dueDate ? (
                <span>
                  {strings.due}: {formatDate(project.dueDate, locale)}
                </span>
              ) : null}
            </div>
            <div className="row text-muted" style={{ fontSize: "0.8rem" }}>
              <span>
                {strings.taskProgress}: {taskCounts.open} {strings.openTasks.toLowerCase()} · {taskCounts.done}{" "}
                {strings.doneTasks.toLowerCase()}
              </span>
            </div>
            {criteriaTotal > 0 ? (
              <div>
                <p className="text-muted" style={{ fontSize: "0.8rem", margin: "4px 0 0" }}>
                  {strings.criteria}: {criteriaDone}/{criteriaTotal}
                </p>
                <div className="criteria-progress">
                  <span style={{ width: `${criteriaPct}%` }} />
                </div>
              </div>
            ) : null}
          </div>
          <PaperlessAttachmentStrip attachments={attachments} />
          {attachmentError ? (
            <p className="capture-error" role="alert">{attachmentError}</p>
          ) : null}
          {project.stuckReason ? <ProjectStuckNotice reason={project.stuckReason} /> : null}
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
        projectId={projectId}
        autoOpen={focus === "next-action"}
        onAutoOpenClose={clearRouteFocus}
      />
      {(editing || focus === "driver" || focus === "completion") && project ? (
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
            if (focus === "driver" || focus === "completion") clearRouteFocus();
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
      {focus === "outcome" && project ? (
        <StoryCriteriaSheet story={project} onClose={clearRouteFocus} />
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
  );
}
