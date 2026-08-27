import { useState } from "react";
import type { ProjectWithActions } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { api } from "../lib/api";
import { strings } from "../lib/strings";
import { ownerAssignmentPatch } from "./TaskQuickActionSheet";
import { AssignOwnerSheet } from "./AssignOwnerSheet";
import { BottomSheet } from "./BottomSheet";
import { CaptureForm } from "./CaptureForm";
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
  const { bump } = useRefresh();

  const close = () => {
    setOpen(false);
    setError(null);
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
          <CaptureForm
            projectId={projectId ?? null}
            parentTaskId={parentTaskId ?? null}
            onCancel={close}
            onCaptured={(result) => {
              bump();
              close();
              if (result.kind === "project") {
                setCreatedProject(result.project);
              } else if (result.needsClarification) {
                setCaptureNotice(strings.filedInInbox);
              } else {
                setCaptureNotice(null);
                setCreatedTask(result.task);
              }
            }}
          />
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
