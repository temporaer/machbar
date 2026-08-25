import { useEffect, useMemo, useState } from "react";
import type { Project, Task } from "@machbar/shared";
import { api } from "../lib/api";
import { strings } from "../lib/strings";
import { useRefresh } from "../lib/refresh";
import { flattenTasks, sortByPosition } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";
import { LoadingState, ErrorState } from "./AsyncStates";

export type MoveMode = "parent" | "project" | "subtree";

/**
 * Explicit picker used by the organize-mode controls: change parent, move
 * to another project, or move a whole subtree (project + parent in one
 * step). All three are reachable without any drag gesture.
 */
export function MoveTaskSheet({ task, mode, onClose }: { task: Task; mode: MoveMode; onClose: () => void }) {
  const { bump } = useRefresh();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectTasks, setProjectTasks] = useState<Task[] | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(task.projectId);
  const [selectedParentId, setSelectedParentId] = useState<number | null>(task.parentTaskId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const needsProjectStep = mode === "project" || mode === "subtree";
  const needsParentStep = mode === "parent" || mode === "subtree";

  useEffect(() => {
    setLoading(true);
    setError(null);
    const jobs: Promise<unknown>[] = [];
    if (needsProjectStep) jobs.push(api.getProjects().then(setProjects));
    if (needsParentStep && selectedProjectId != null) {
      jobs.push(api.getProject(selectedProjectId).then((p) => setProjectTasks(p.tasks)));
    } else if (needsParentStep) {
      setProjectTasks([]);
    }
    Promise.all(jobs)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsProjectStep, needsParentStep, selectedProjectId]);

  const excludedIds = useMemo(() => {
    const ids = new Set<number>([task.id]);
    for (const descendant of flattenTasks(task.children)) ids.add(descendant.id);
    return ids;
  }, [task]);

  const selectableParents = useMemo(() => {
    if (!projectTasks) return [];
    return sortByPosition(flattenTasks(projectTasks).filter((t) => !excludedIds.has(t.id)));
  }, [projectTasks, excludedIds]);

  const title =
    mode === "parent" ? strings.changeParentTitle : mode === "project" ? strings.moveProjectTitle : strings.moveSubtree;

  const submit = async () => {
    setSaving(true);
    try {
      if (mode === "parent") {
        if (selectedParentId === null) {
          await api.changeParent(task.id, null, task.projectId);
        } else {
          await api.changeParent(task.id, selectedParentId);
        }
      } else if (mode === "project") {
        await api.moveSubtree(task.id, selectedProjectId);
      } else {
        await api.moveTask(task.id, {
          projectId: selectedProjectId,
          parentTaskId: selectedParentId,
        });
      }
      bump();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet title={title} onClose={onClose} labelledBy="move-task-title">
      <p className="text-muted">{task.title}</p>
      {mode === "subtree" ? <p className="text-muted">{strings.subtreeHint}</p> : null}
      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <div className="stack">
          {needsProjectStep ? (
            <div className="field">
              <label htmlFor="move-project-select">{strings.selectProject}</label>
              <select
                id="move-project-select"
                value={selectedProjectId ?? ""}
                onChange={(e) => {
                  const val = e.target.value ? Number(e.target.value) : null;
                  setSelectedProjectId(val);
                  setSelectedParentId(null);
                }}
              >
                <option value="">{strings.noProject}</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {needsParentStep ? (
            <div className="field">
              <label htmlFor="move-parent-select">{strings.selectParent}</label>
              <select
                id="move-parent-select"
                value={selectedParentId ?? ""}
                onChange={(e) => setSelectedParentId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{strings.noParent}</option>
                {selectableParents.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>
              {strings.cancel}
            </button>
            <button type="button" className="btn btn-primary btn-block" disabled={saving} onClick={() => void submit()}>
              {strings.moveHere}
            </button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
