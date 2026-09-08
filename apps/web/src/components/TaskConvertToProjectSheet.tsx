import { useState } from "react";
import type { Task } from "@machbar/shared";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useRefresh } from "../lib/refresh";
import { isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { BottomSheet } from "./BottomSheet";
import { CapturedProjectHandoff } from "./CapturedProjectHandoff";

/** Focused `task.convertToProject` workflow — the canonical destination regardless of rail/keyboard/detail invocation. */
export function TaskConvertToProjectSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const { bump } = useRefresh();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<Awaited<ReturnType<typeof api.convertTaskToStory>> | null>(null);

  const unresolvedDependencyCount = task.dependencies.filter((dependency) => !dependency.resolved).length;
  const blockReason =
    task.status === "done" || task.status === "cancelled"
      ? strings.convertToProjectUnsupportedStatus
      : task.externalWait !== null ||
          unresolvedDependencyCount > 0 ||
          task.repeatAfterDays !== null ||
          task.allowedDeviationDays !== null ||
          task.reminderAt !== null
        ? strings.convertToProjectTaskOnlyRelations
        : null;

  const convert = async (status: "active" | "backlog") => {
    if (busy || blockReason) return;
    setBusy(true);
    setError(null);
    try {
      const converted = await api.convertTaskToStory(task.id, {
        status,
        expectedRevision: task.revision,
      });
      bump();
      setProject(converted);
    } catch (cause) {
      if (isStaleWriteConflict(cause)) bump();
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
      title={`${strings.convertToProject}: ${task.title}`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="stack">
        {blockReason ? (
          <p className="text-muted">{blockReason}</p>
        ) : (
          <div className="capture-shape-actions">
            <button
              type="button"
              className="btn btn-primary capture-shape-action"
              disabled={busy}
              onClick={() => void convert("backlog")}
            >
              {strings.convertToProjectBacklog}
            </button>
            <button
              type="button"
              className="btn capture-shape-action"
              disabled={busy}
              onClick={() => void convert("active")}
            >
              {strings.convertToProjectActive}
            </button>
          </div>
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
