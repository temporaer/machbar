import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { strings, projectStatusLabels } from "../lib/strings";
import { LoadingState, ErrorState } from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { QuickAdd } from "../components/QuickAdd";
import { ProjectEditSheet } from "../components/ProjectEditSheet";
import { countTasks, flattenTasks } from "../lib/taskHelpers";
import { useIdentity } from "../lib/identity";
import { formatDate } from "../lib/format";
import { ProjectStuckNotice } from "../components/ProjectStuckNotice";
import { TaskSequenceSheet } from "../components/TaskSequenceSheet";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { MarkdownNotes } from "../components/MarkdownNotes";
import { NativeShareButton } from "../components/NativeShareButton";
import { serializeProjectForShare } from "../lib/shareText";
import { buildProjectShareUrl } from "../lib/shareUrls";
import { useRefresh } from "../lib/refresh";
import { PageHeader } from "../components/PageHeader";
import { useSwipeSettings } from "../lib/swipeSettings";
import { IconActionButton } from "../components/IconActionButton";
import { StoryCriteriaSheet } from "../components/StoryCriteriaSheet";
import { useTaskDetail } from "../lib/taskDetailContext";
import { RecentActivity } from "../components/RecentActivity";

export function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = Number(params.id);
  const [searchParams, setSearchParams] = useSearchParams();
  const focus = searchParams.get("focus");
  const { members } = useIdentity();
  const [editing, setEditing] = useState(false);
  const [addingSequence, setAddingSequence] = useState(false);
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const planningTaskRef = useRef<number | null>(null);
  const planningOwnsSheetRef = useRef(false);
  const planningSheetOpenedRef = useRef(false);
  const { bump } = useRefresh();
  const { openTaskId, open: openTaskDetail, close: closeTaskDetail } = useTaskDetail();
  const openTaskIdRef = useRef(openTaskId);
  const closeTaskDetailRef = useRef(closeTaskDetail);
  openTaskIdRef.current = openTaskId;
  closeTaskDetailRef.current = closeTaskDetail;
  const { primarySwipeAction } = useSwipeSettings();
  const {
    data: project,
    loading: projectLoading,
    error: projectError,
    reload: reloadProject,
  } = useAsync(() => api.getProject(projectId), [projectId]);

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

  useEffect(() => {
    if (project && !notesEditing) setNotesDraft(project.notes);
  }, [project, notesEditing]);

  const saveNotes = async () => {
    if (!project || notesSaving) return;
    setNotesSaving(true);
    setNotesError(null);
    try {
      await api.updateProject(project.id, { notes: notesDraft });
      setNotesEditing(false);
      bump();
      reloadProject();
    } catch (cause) {
      setNotesError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setNotesSaving(false);
    }
  };

  return (
    <div>
      <Link to="/projekte" className="link-plain">
        ← {strings.projects}
      </Link>
      {projectLoading ? <LoadingState /> : null}
      {projectError ? <ErrorState message={projectError} onRetry={reloadProject} /> : null}
      {project ? (
        <>
          <div className="page-header" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div className="row-between">
              <h1>{project.title}</h1>
              <div className="row">
                <NativeShareButton
                  title={project.title}
                  text={serializeProjectForShare(project)}
                  url={buildProjectShareUrl(project.id)}
                />
                <IconActionButton
                  kind="edit"
                  label={strings.edit}
                  onClick={() => setEditing(true)}
                />
              </div>
            </div>
            <div className="row text-muted" style={{ fontSize: "0.8rem" }}>
              <span className="badge">{projectStatusLabels[project.status]}</span>
              <span>
                {strings.driver}: {owner ? owner.name : strings.noDriver}
              </span>
              {project.dueDate ? (
                <span>
                  {strings.due}: {formatDate(project.dueDate)}
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
          {project.stuckReason ? <ProjectStuckNotice reason={project.stuckReason} /> : null}
          <section className="section project-notes-section">
            <div className="row-between">
              <h2 className="section-title">{strings.notes}</h2>
              {!notesEditing ? (
                <IconActionButton
                  kind="edit"
                  label={strings.edit}
                  onClick={() => setNotesEditing(true)}
                />
              ) : null}
            </div>
            {notesEditing ? (
              <div className="stack">
                <MarkdownEditor
                  value={notesDraft}
                  onChange={setNotesDraft}
                  toolbarLabel={strings.markdownToolbar}
                  rows={7}
                  autoFocus
                />
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={notesSaving}
                    onClick={() => {
                      setNotesDraft(project.notes);
                      setNotesError(null);
                      setNotesEditing(false);
                    }}
                  >
                    {strings.cancel}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={notesSaving}
                    onClick={() => void saveNotes()}
                  >
                    {strings.saveNotes}
                  </button>
                </div>
                {notesError ? <p className="capture-error" role="alert">{notesError}</p> : null}
              </div>
            ) : notesDraft.trim() ? (
              <MarkdownNotes value={notesDraft} />
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
              hints={[
                {
                  label: strings.taskGestures,
                  text: [
                    strings.taskGestureHint(
                      strings.primarySwipeActionLabels[primarySwipeAction],
                    ),
                    strings.dragHint,
                  ],
                },
              ]}
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
          focusField={
            focus === "driver"
              ? "driver"
              : focus === "completion"
                ? "completion"
                : undefined
          }
          onClose={() => {
            setEditing(false);
            if (focus === "driver" || focus === "completion") clearRouteFocus();
          }}
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
    </div>
  );
}
