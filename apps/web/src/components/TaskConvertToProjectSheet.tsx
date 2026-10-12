import { useEffect, useMemo, useState } from "react";
import type { ProjectActivationResolution, Task } from "@machbar/shared";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useRefresh } from "../lib/refresh";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { projectActivationPromptFromError, projectActivationResolutionFromPrompt, type ProjectActivationPrompt } from "../lib/projectActivationResolution";
import { BottomSheet } from "./BottomSheet";
import { CapturedProjectHandoff } from "./CapturedProjectHandoff";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";

function descendantRevisions(tasks: Task[]): Array<{ taskId: number; revision: number }> {
  return tasks.flatMap((child) => [
    { taskId: child.id, revision: child.revision },
    ...descendantRevisions(child.children),
  ]);
}

/** Focused `task.convertToProject` workflow — the canonical destination regardless of rail/keyboard/detail invocation. */
export function TaskConvertToProjectSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const { bump } = useRefresh();
  const dispatch = useWorkItemCommands();
  const [currentTask, setCurrentTask] = useState(task);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preservedStepTitle, setPreservedStepTitle] = useState(task.title);
  const [preservedStepTitleEdited, setPreservedStepTitleEdited] = useState(false);
  const [dependencyTargets, setDependencyTargets] = useState<Record<number, number>>({});
  const [activationPrompt, setActivationPrompt] = useState<ProjectActivationPrompt | null>(null);
  const [project, setProject] = useState<Awaited<ReturnType<typeof api.convertTaskToStory>> | null>(null);
  useEffect(() => {
    setCurrentTask(task);
    if (!preservedStepTitleEdited) setPreservedStepTitle(task.title);
  }, [task, preservedStepTitleEdited]);
  const blockReason =
    currentTask.status === "done" || currentTask.status === "cancelled"
      ? strings.convertToProjectUnsupportedStatus
      : currentTask.parentTaskId !== null || currentTask.projectId !== null
      ? strings.convertToProjectNotStandalone
        : null;
  const openChildren = useMemo(
    () => currentTask.children.filter((child) => child.kind === "action" && child.status !== "done" && child.status !== "cancelled"),
    [currentTask.children],
  );
  const preserveStepRequired = currentTask.externalWait !== null || currentTask.dependencies.length > 0 ||
    currentTask.repeatAfterDays !== null || currentTask.allowedDeviationDays !== null ||
    currentTask.reminders.length > 0 || currentTask.scheduledDate !== null ||
    currentTask.notBeforeAt != null || currentTask.notBeforeDate != null ||
    (currentTask.status === "actionable" && openChildren.length === 0);
  const executionCommitmentPresent = currentTask.status === "actionable" || currentTask.dueDate !== null ||
    currentTask.scheduledDate !== null || currentTask.reminders.length > 0 || currentTask.repeatAfterDays !== null;
  const activationResolution: ProjectActivationResolution | null = activationPrompt
    ? projectActivationResolutionFromPrompt(activationPrompt)
    : null;

  const convert = async (status: "active" | "backlog") => {
    if (busy || blockReason) return;
    setBusy(true);
    setError(null);
    try {
      const converted = await api.convertTaskToStory(task.id, {
        status,
        ...(preserveStepRequired ? { preservedStepTitle: preservedStepTitle.trim() } : {}),
        dependencyMappings: Object.entries(dependencyTargets).map(([dependencyId, targetTaskId]) => {
          const dependency = currentTask.dependencies.find((candidate) => candidate.id === Number(dependencyId));
          return {
            dependencyId: Number(dependencyId),
            targetTaskId,
            sourceEndpoint: dependency?.taskId === currentTask.id ? "task" as const : "dependsOnTask" as const,
          };
        }),
        expectedDescendantRevisions: descendantRevisions(currentTask.children),
        ...(activationResolution ? { activationResolution } : {}),
        expectedRevision: currentTask.revision,
      });
      bump();
      setProject(converted);
      if (status === "active") dispatch({ type: "story.activate", story: converted });
    } catch (cause) {
      const refreshedPrompt = projectActivationPromptFromError(cause, activationPrompt);
      if (refreshedPrompt) setActivationPrompt(refreshedPrompt);
      if (isStaleWriteConflict(cause)) {
        bump();
        try {
          const latest = await api.getTask(task.id);
          setCurrentTask(latest);
        } catch {
          // Keep the draft and let the next submission surface the current server error.
        }
      }
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setBusy(false);
    }
  };

  if (project) {
    return <CapturedProjectHandoff project={project} onDone={onClose} />;
  }

  return (
    <BottomSheet
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
            {executionCommitmentPresent ? <p className="text-muted">{strings.convertToProjectCommitmentActive}</p> : null}
            {preserveStepRequired ? (
              <label className="field">
                <span>{strings.convertToProjectPreservedStep}</span>
                <input value={preservedStepTitle} onChange={(event) => {
                  setPreservedStepTitleEdited(true);
                  setPreservedStepTitle(event.target.value);
                }} disabled={busy} />
              </label>
            ) : null}
            {currentTask.dependencies.map((dependency) => (
              <label className="field" key={dependency.id}>
                <span>{strings.convertToProjectDependencyTarget}: {dependency.title ?? String(dependency.dependsOnTaskId)}</span>
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
              <button type="button" className="btn btn-primary capture-shape-action" disabled={busy || (preserveStepRequired && !preservedStepTitle.trim()) || (activationPrompt !== null && activationResolution === null)} onClick={() => void convert("backlog")}>{strings.convertToProjectBacklog}</button>
              <button type="button" className="btn capture-shape-action" disabled={busy || (preserveStepRequired && !preservedStepTitle.trim()) || (activationPrompt !== null && activationResolution === null)} onClick={() => void convert("active")}>{strings.convertToProjectActive}</button>
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
