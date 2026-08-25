import { useEffect, useMemo, useState } from "react";
import type { Project, Task } from "@machbar/shared";
import { api } from "../lib/api";
import { strings } from "../lib/strings";
import { useRefresh } from "../lib/refresh";
import { flattenTasks, sortByPosition } from "../lib/taskHelpers";
import { rememberDestination } from "../lib/recentDestinations";
import { BottomSheet } from "./BottomSheet";
import { DestinationPicker, type DestinationOption } from "./DestinationPicker";
import { LoadingState, ErrorState } from "./AsyncStates";

export type MoveMode = "parent" | "project" | "subtree";

/**
 * Explicit picker used by the organize-mode controls: change parent, move
 * to another project, or move a whole subtree (project + parent in one
 * step). All three are reachable without any drag gesture.
 *
 * Both destination lists are `DestinationPicker`s: searchable, with the
 * recently used targets on top. The candidate sets are unchanged — the
 * task's own subtree is still excluded client-side, and every mode still
 * goes through the same API call, so the server keeps the final say on
 * hierarchy/cycle validity.
 */
export function MoveTaskSheet({ task, mode, onClose }: { task: Task; mode: MoveMode; onClose: () => void }) {
  const { bump } = useRefresh();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectTasks, setProjectTasks] = useState<Task[] | null>(null);
  const [parentProjectTitle, setParentProjectTitle] = useState<string | null>(null);
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
      jobs.push(
        api.getProject(selectedProjectId).then((p) => {
          setProjectTasks(p.tasks);
          // Kept so parent candidates stay searchable by their project even
          // in `parent` mode, where the full project list is never fetched.
          setParentProjectTitle(p.title);
        }),
      );
    } else if (needsParentStep) {
      setProjectTasks([]);
      setParentProjectTitle(null);
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

  const projectOptions = useMemo<DestinationOption[]>(
    () => (projects ?? []).map((p) => ({ id: p.id, title: p.title })),
    [projects],
  );

  /**
   * Parent candidates are searchable by their own title *and* by the project
   * they sit in, which is how people actually remember them ("the Umzug
   * one"). The subtitle is the selected project, since every candidate in
   * this list belongs to it.
   */
  const parentOptions = useMemo<DestinationOption[]>(() => {
    const projectTitle =
      projects?.find((p) => p.id === selectedProjectId)?.title ?? parentProjectTitle;
    return selectableParents.map((t) => ({ id: t.id, title: t.title, subtitle: projectTitle }));
  }, [selectableParents, projects, selectedProjectId, parentProjectTitle]);

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
      // Only a move the server accepted is worth offering as a shortcut.
      if (needsProjectStep) rememberDestination("project", selectedProjectId);
      if (needsParentStep) rememberDestination("parent", selectedParentId);
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
            <DestinationPicker
              kind="project"
              label={strings.selectProject}
              options={projectOptions}
              value={selectedProjectId}
              onChange={(id) => {
                setSelectedProjectId(id);
                setSelectedParentId(null);
              }}
              noneLabel={strings.noProject}
            />
          ) : null}
          {needsParentStep ? (
            <DestinationPicker
              kind="parent"
              label={strings.selectParent}
              options={parentOptions}
              value={selectedParentId}
              onChange={setSelectedParentId}
              noneLabel={strings.noParent}
            />
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
