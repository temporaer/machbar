import { useState } from "react";
import type { ProjectWithActions, CreateTaskInput } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { api } from "../lib/api";
import { strings } from "../lib/strings";
import { ownerAssignmentPatch } from "./TaskQuickActionSheet";
import { AssignOwnerSheet } from "./AssignOwnerSheet";
import { BottomSheet } from "./BottomSheet";
import { CaptureProjectBreakdownSheet } from "./CaptureProjectBreakdownSheet";
import { DestinationPicker, type DestinationOption } from "./DestinationPicker";

/**
 * Global quick-add: a single always-reachable floating button. Essential
 * because task creation must not depend on navigating into a specific
 * project or list first — a bare title is enough and the task lands in
 * Eingang (inbox) for later clarification/refile.
 */
export function QuickAdd({ projectId, parentTaskId }: { projectId?: number | null; parentTaskId?: number | null }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdTask, setCreatedTask] = useState<Awaited<ReturnType<typeof api.createTask>> | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectWithActions[] | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [projectPickerError, setProjectPickerError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [createdProject, setCreatedProject] = useState<ProjectWithActions | null>(null);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();

  const close = () => {
    setOpen(false);
    setTitle("");
    setError(null);
  };

  const taskInput = (needsClarification: boolean): CreateTaskInput => ({
    title: title.trim(),
    projectId: projectId ?? null,
    parentTaskId: parentTaskId ?? null,
    createdByMemberId: currentMemberId,
    status: "actionable",
    needsClarification,
    dueDate: null,
    scheduledDate: null,
    ...(currentMemberId === null ? {} : ownerAssignmentPatch(currentMemberId)),
  });

  const createTask = async (needsClarification: boolean) => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const task = await api.createTask(taskInput(needsClarification));
      bump();
      close();
      if (needsClarification) {
        setCaptureNotice(strings.filedInInbox);
        return;
      }
      setCaptureNotice(null);
      setCreatedTask(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const createProject = async () => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const project = await api.createProject({
        title: trimmed,
        status: currentMemberId === null ? "backlog" : "active",
        ownerMemberId: currentMemberId,
      });
      bump();
      close();
      setCreatedProject(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const loadProjects = () => {
    setProjectPickerError(null);
    setProjects(null);
    void api
      .getProjects()
      .then(setProjects)
      .catch((err: unknown) => setProjectPickerError(err instanceof Error ? err.message : String(err)));
  };

  const openProjectPicker = () => {
    setSelectedProjectId(createdTask?.projectId ?? null);
    setProjectPickerOpen(true);
    loadProjects();
  };

  const moveToProject = async () => {
    if (!createdTask || moving) return;
    setMoving(true);
    setProjectPickerError(null);
    try {
      await api.moveSubtree(createdTask.id, selectedProjectId);
      bump();
      setProjectPickerOpen(false);
    } catch (err) {
      setProjectPickerError(err instanceof Error ? err.message : String(err));
    } finally {
      setMoving(false);
    }
  };

  const undo = async () => {
    if (!createdTask || moving) return;
    setMoving(true);
    setError(null);
    try {
      await api.deleteTask(createdTask.id);
      bump();
      setCreatedTask(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMoving(false);
    }
  };

  const projectOptions: DestinationOption[] = (projects ?? []).map((project) => ({
    id: project.id,
    title: project.title,
  }));

  return (
    <>
      <button
        type="button"
        className="quick-add-fab"
        onClick={() => {
          setCaptureNotice(null);
          setOpen(true);
        }}
        aria-label={strings.quickAdd}
      >
        +
      </button>
      {open ? (
        <BottomSheet title={strings.quickAdd} onClose={close} labelledBy="quick-add-title">
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void createTask(true);
            }}
          >
            <div className="field">
              <label htmlFor="quick-add-input">{strings.titleEnough}</label>
              <input
                id="quick-add-input"
                autoFocus
                value={title}
                placeholder={strings.quickAddPlaceholder}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            {error ? <p className="capture-error" role="alert">{error}</p> : null}
            <div className="row">
              <button type="button" className="btn" onClick={close}>
                {strings.cancel}
              </button>
              <button type="submit" className="btn" disabled={saving || !title.trim()}>
                {strings.clarifyLater}
              </button>
              <button type="button" className="btn btn-primary capture-shape-action" aria-label={strings.captureMachbar} disabled={saving || !title.trim()} onClick={() => void createTask(false)}>
                <span>{strings.captureMachbar}</span>
                <small>{strings.captureMachbarHint}</small>
              </button>
              <button type="button" className="btn btn-primary capture-shape-action" aria-label={strings.captureProject} disabled={saving || !title.trim()} onClick={() => void createProject()}>
                <span>{strings.captureProject}</span>
                <small>{strings.captureProjectHint}</small>
              </button>
            </div>
          </form>
        </BottomSheet>
      ) : null}
      {createdTask ? (
        <section className="capture-correction-toast" role="status" aria-live="polite">
          <strong>{strings.addedToToday}</strong>
          {error ? <p className="capture-error" role="alert">{error}</p> : null}
          <div className="capture-correction-actions">
            <button type="button" className="btn btn-sm" disabled={assigning || moving} onClick={() => setAssigning(true)}>
              {strings.changeOwner}
            </button>
            <button type="button" className="btn btn-sm" disabled={assigning || moving} onClick={openProjectPicker}>
              {strings.selectProject}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={assigning || moving} onClick={() => void undo()}>
              {strings.undo}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={assigning || moving} onClick={() => setCreatedTask(null)}>
              {strings.close}
            </button>
          </div>
        </section>
      ) : null}
      {captureNotice ? (
        <section className="capture-correction-toast" role="status" aria-live="polite">
          <strong>{captureNotice}</strong>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCaptureNotice(null)}>
            {strings.close}
          </button>
        </section>
      ) : null}
      {assigning && createdTask ? (
        <AssignOwnerSheet
          title={strings.changeOwner}
          groupId={`capture-owner-${createdTask.id}`}
          currentOwnerId={createdTask.ownerMemberId}
          onClose={() => setAssigning(false)}
          onAssign={async (ownerMemberId) => {
            const task = await api.updateTask(createdTask.id, ownerAssignmentPatch(ownerMemberId));
            setCreatedTask(task);
            bump();
          }}
        />
      ) : null}
      {projectPickerOpen && createdTask ? (
        <BottomSheet title={strings.selectProject} onClose={() => setProjectPickerOpen(false)} labelledBy="capture-project-picker-title">
          <div className="stack">
            {projectPickerError ? <p className="capture-error" role="alert">{projectPickerError}</p> : null}
            {projects ? (
              <>
                <DestinationPicker
                  kind="project"
                  label={strings.selectProject}
                  options={projectOptions}
                  value={selectedProjectId}
                  onChange={setSelectedProjectId}
                  noneLabel={strings.noProject}
                  autoFocus
                />
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  disabled={moving}
                  onClick={() => void moveToProject()}
                >
                  {strings.moveHere}
                </button>
              </>
            ) : (
              <div className="stack">
                <p className="text-muted">{strings.loading}</p>
                {projectPickerError ? (
                  <button type="button" className="btn" onClick={loadProjects}>
                    {strings.retry}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </BottomSheet>
      ) : null}
      {createdProject ? (
        <CaptureProjectBreakdownSheet project={createdProject} onClose={() => setCreatedProject(null)} />
      ) : null}
    </>
  );
}
