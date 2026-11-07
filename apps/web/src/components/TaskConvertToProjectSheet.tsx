import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectActivationResolution, Task } from "@machbar/shared";
import { api, type TaskDetail } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useRefresh } from "../lib/refresh";
import { isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { projectActivationPromptFromSnapshot, projectActivationPromptFromError, projectActivationResolutionFromPrompt, type ProjectActivationPrompt } from "../lib/projectActivationResolution";
import { BottomSheet, type BottomSheetPresentationProps } from "./BottomSheet";
import { useNavigate } from "react-router-dom";
import { useTaskDetail } from "../lib/taskDetailContext";
import { useTaskActions } from "../lib/useTaskActions";
import { useProjectActions } from "../lib/useProjectActions";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";

function descendantRevisions(tasks: Task[]): Array<{ taskId: number; revision: number }> {
  return tasks.flatMap((child) => [
    { taskId: child.id, revision: child.revision },
    ...descendantRevisions(child.children),
  ]);
}

function openActionDescendants(tasks: Task[]): Task[] {
  return tasks.flatMap((task) => [
    ...(task.kind === "action" && task.status !== "done" && task.status !== "cancelled" ? [task] : []),
    ...openActionDescendants(task.children),
  ]);
}

/** Focused `task.convertToProject` workflow — the canonical destination regardless of rail/keyboard/detail invocation. */
export function TaskConvertToProjectSheet({ task, authoritativeTask = task, onClose, ...presentation }: {
  task: Task; authoritativeTask?: Task | null; onClose: () => void;
} & BottomSheetPresentationProps) {
  const strings = useStrings();
  const taskActions = useTaskActions();
  const projectActions = useProjectActions();
  const navigate = useNavigate();
  const detail = useTaskDetail();
  const { bump } = useRefresh();
  const [taskRead, setCurrentTask] = useState<TaskDetail | null>(null);
  const localTask = taskRead && taskActions.isCurrentTaskRead(taskRead) ? taskRead : null;
  const hostTask = authoritativeTask?.id === task.id ? authoritativeTask : null;
  const authority = localTask && (!hostTask || localTask.revision >= hostTask.revision)
    ? localTask : hostTask;
  const currentTask: TaskDetail = authority ?? task;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preservedStepTitle, setPreservedStepTitle] = useState(task.title);
  const [preservedStepTitleEdited, setPreservedStepTitleEdited] = useState(false);
  const [dependencyTargets, setDependencyTargets] = useState<Record<number, number>>({});
  const [previewIntent, setPreviewIntent] = useState<"active" | "backlog" | null>(null);
  const [activationPrompt, setActivationPrompt] = useState<ProjectActivationPrompt | null>(null);

  useEffect(() => {
    if (!preservedStepTitleEdited) setPreservedStepTitle(currentTask.title);
  }, [currentTask.title, preservedStepTitleEdited]);
  useEffect(() => {
    let cancelled = false;
    taskActions.getTask(task.id).then((latest) => { if (!cancelled) setCurrentTask(latest); }).catch((cause) => { if (!cancelled) setError(localizedErrorMessage(cause, strings)); });
    return () => { cancelled = true; };
  }, [task.id, task.revision, strings]);
  const blockReason =
    currentTask.status === "done" || currentTask.status === "cancelled"
      ? strings.convertToProjectUnsupportedStatus
      : null;
  const openChildren = useMemo(
    () => openActionDescendants(currentTask.children),
    [currentTask.children],
  );
  const dependencies = useMemo(() => [
    ...currentTask.dependencies.map((dependency) => ({ ...dependency, endpoint: "task" as const })),
    ...currentTask.incomingDependencies.map((dependency) => ({ ...dependency, endpoint: "dependsOnTask" as const })),
  ], [currentTask.dependencies, currentTask.incomingDependencies]);
  const preserveStepRequired = currentTask.externalWait !== null || currentTask.revisitAt !== null || dependencies.length > 0 ||
    currentTask.repeatAfterDays !== null || currentTask.allowedDeviationDays !== null ||
    currentTask.reminders.length > 0 || currentTask.scheduledDate !== null || currentTask.availabilityRule !== null ||
    currentTask.notBeforeAt != null || currentTask.notBeforeDate != null ||
    (currentTask.status === "actionable" && openChildren.length === 0);
  const activationResolution: ProjectActivationResolution | null = activationPrompt
    ? projectActivationResolutionFromPrompt(activationPrompt)
    : null;
  const activationUnavailable = activationPrompt?.readUnavailable || (activationPrompt?.isCurrentRead && !activationPrompt.isCurrentRead());

  const decisionDraft = useRef<ProjectActivationPrompt | null>(null);
  useEffect(() => { if (activationPrompt) decisionDraft.current = activationPrompt; }, [activationPrompt]);
  useEffect(() => { setActivationPrompt(null); setPreviewIntent(null); }, [preservedStepTitle, dependencyTargets, currentTask.revision]);

  const hierarchyPending = (currentTask.parentTaskId !== null || currentTask.projectId !== null) && !currentTask.hierarchyRevisions;

  const convert = async (status: "active" | "backlog") => {
    const continuation = taskActions.captureTargetRead(task.id);
    const projectContinuation = currentTask.projectId === null ? null : projectActions.captureTargetRead(currentTask.projectId);
    const isCurrent = () => taskActions.isCurrentTargetRead(continuation) &&
      (!projectContinuation || projectActions.isCurrentTargetRead(projectContinuation));
    if (!authority || busy || blockReason || hierarchyPending) return;
    setBusy(true);
    setError(null);
    try {
      if (activationUnavailable && currentTask.projectId !== null && !projectActions.isTargetReadable(currentTask.projectId)) {
        const project = await projectActions.getProject(currentTask.projectId);
        if (!isCurrent() || !projectActions.isCurrentProjectRead(project)) return;
      }
      const input = {
        status,
        ...(preserveStepRequired ? { preservedStepTitle: preservedStepTitle.trim() } : {}),
        dependencyMappings: Object.entries(dependencyTargets).map(([dependencyId, targetTaskId]) => {
          const dependency = dependencies.find((candidate) => candidate.id === Number(dependencyId));
          return {
            dependencyId: Number(dependencyId),
            targetTaskId,
            sourceEndpoint: dependency?.endpoint ?? "task",
          };
        }),
        ...(currentTask.hierarchyRevisions ? { expectedHierarchyRevisions: currentTask.hierarchyRevisions } : {}),
        expectedDescendantRevisions: currentTask.hierarchyRevisions
          ? currentTask.hierarchyRevisions.filter((entry) => entry.id !== currentTask.id && !currentTask.ancestors?.some((parent) => parent.id === entry.id)).map(({ id, revision }) => ({ taskId: id, revision }))
          : descendantRevisions(currentTask.children),
        ...(previewIntent === status && activationPrompt?.projects.length && activationResolution ? { activationResolution } : {}),
        expectedRevision: currentTask.revision,
      };
      if (!activationPrompt || activationUnavailable || previewIntent !== status) {
        const preview = await api.previewTaskConversion(task.id, input);
        if (!isCurrent()) return;
        if (preview.activatingProjects.length) {
          setPreviewIntent(status);
          setActivationPrompt({ ...projectActivationPromptFromSnapshot(preview.decision, decisionDraft.current), isCurrentRead: isCurrent });
          return;
        }
      }
      if (!isCurrent()) return;
      const converted = await api.convertTaskToStory(task.id, input);
      if (!isCurrent()) return;
      bump();
      onClose();
      detail.close();
      navigate(`/projects/${converted.id}`, { state: { createdProjectId: converted.id } });

    } catch (cause) {
      if (!isCurrent()) return;
      const refreshedPrompt = projectActivationPromptFromError(cause, activationPrompt);
      if (refreshedPrompt) { setPreviewIntent(status); setActivationPrompt({ ...refreshedPrompt, isCurrentRead: isCurrent }); }
      if (isStaleWriteConflict(cause)) {
        bump();
        try {
          const latest = await taskActions.getTask(task.id);
          if (!isCurrent() || !taskActions.isCurrentTaskRead(latest)) return;
          setCurrentTask(latest);
        } catch {
          // Keep the draft and let the next submission surface the current server error.
        }
        if (!isCurrent()) return;
      }
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setBusy(false);
    }
  };


  return (
    <BottomSheet
      {...presentation}
      title={`${strings.convertToProject}: ${currentTask.title}`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="stack">
        {blockReason ? (
          <p className="text-muted">{blockReason}</p>
        ) : (
          <>
            {preserveStepRequired ? (
              <label className="field">
                <span>{strings.convertToProjectPreservedStep}</span>
                <input value={preservedStepTitle} onChange={(event) => {
                  setPreservedStepTitleEdited(true);
                  setPreservedStepTitle(event.target.value);
                }} disabled={busy} />
              </label>
            ) : null}
            {dependencies.map((dependency) => (
              <label className="field" key={dependency.id}>
                <span>{dependency.endpoint === "task" ? strings.convertToProjectOutgoingDependency : strings.convertToProjectIncomingDependency}: {dependency.title ?? String(dependency.endpoint === "task" ? dependency.dependsOnTaskId : dependency.taskId)}</span>
                <select
                  value={dependencyTargets[dependency.id] ?? "preserved"}
                  onChange={(event) => setDependencyTargets((previous) => {
                    const next = { ...previous };
                    if (event.target.value === "preserved") delete next[dependency.id];
                    else next[dependency.id] = Number(event.target.value);
                    return next;
                  })}
                  disabled={busy}
                >
                  <option value="preserved">{strings.convertToProjectPreservedStep}</option>
                  {openChildren.map((child) => <option key={child.id} value={child.id}>{child.title}</option>)}
                </select>
              </label>
            ))}
            {activationPrompt ? <ProjectActivationDecisionFields prompt={activationPrompt} disabled={busy} onChange={setActivationPrompt} /> : null}
            <div className="capture-shape-actions">
              <button type="button" className="btn btn-primary capture-shape-action" disabled={!authority || busy || hierarchyPending || (preserveStepRequired && !preservedStepTitle.trim()) || (previewIntent === "backlog" && activationPrompt !== null && !activationUnavailable && activationResolution === null)} onClick={() => void convert("backlog")}>{strings.convertToProjectBacklog}</button>
              <button type="button" className="btn capture-shape-action" disabled={!authority || busy || hierarchyPending || (preserveStepRequired && !preservedStepTitle.trim()) || (previewIntent === "active" && activationPrompt !== null && !activationUnavailable && activationResolution === null)} onClick={() => void convert("active")}>{previewIntent === "active" && activationPrompt ? strings.activateStory : strings.convertToProjectActive}</button>
            </div>
          </>
        )}
        {error ? (
          <div className="task-row-error" role="alert">
            {error}
          </div>
        ) : null}
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
