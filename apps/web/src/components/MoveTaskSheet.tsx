import { useEffect, useMemo, useState } from "react";
import type { Project, Task } from "@machbar/shared";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { useRefresh } from "../lib/refresh";
import { flattenTasks, sortByPosition } from "../lib/taskHelpers";
import { rememberDestination } from "../lib/recentDestinations";
import { BottomSheet, type BottomSheetPresentationProps } from "./BottomSheet";
import { DestinationPicker, type DestinationOption } from "./DestinationPicker";
import { LoadingState, ReadErrorState } from "./AsyncStates";
import { useLocale } from "../lib/locale";
import { useProjectActions } from "../lib/useProjectActions";
import type { ProjectDetail } from "../lib/api";
import { sortProjectDestinations } from "../lib/sortOrder";
import { useTaskActions } from "../lib/useTaskActions";

/**
 * Explicit picker for destinations that are nowhere near on screen: move a
 * task (and its whole subtree) to another project and, optionally, another
 * parent task within it — both in one step. Reached from `task.changeProject`
 * via `TaskWorkflowHost`, and offered as the Struktur sheet's single
 * "Verschieben …" entry, so refiling stays available as one canonical
 * semantic command without any drag gesture or local component state.
 *
 * Both destination lists are `DestinationPicker`s: searchable, with the
 * recently used targets on top. The task's own subtree is excluded
 * client-side; the server keeps the final say on hierarchy/cycle validity.
 * There is no project-only move without the parent step: the data model
 * (`work_items.parentId`-only hierarchy) means every move already carries
 * the whole subtree, so this is the only project-move path — a project
 * picker plus an optional parent picker ("Keine" meaning root).
 */
export function MoveTaskSheet({ task, onClose, ...presentation }: { task: Task; onClose: () => void } & BottomSheetPresentationProps) {
  const strings = useStrings();
  const projectActions = useProjectActions();
  const taskActions = useTaskActions();
  const { locale } = useLocale();
  const { bump } = useRefresh();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [destination, setDestination] = useState<ProjectDetail | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(task.projectId);
  const currentDestination = destination?.id === selectedProjectId && projectActions.isCurrentProjectRead(destination) ? destination : null;
  const parentProjectTitle = currentDestination?.title ?? null;
  const projectTasks = selectedProjectId === null ? [] : currentDestination?.tasks ?? null;
  const [selectedParentId, setSelectedParentId] = useState<number | null>(task.parentTaskId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const unavailable = selectedProjectId !== null && !currentDestination;
  // Separate from the load `error` above: a failed *submit* must not blank
  // out the picker (the user's selection and search state are still worth
  // keeping around to retry), so it renders inline instead of swapping the
  // whole sheet for `ErrorState`.
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const jobs: Promise<unknown>[] = [api.getProjects().then(values => { if (!cancelled) setProjects(values); })];
    if (selectedProjectId != null) {
      jobs.push(
        projectActions.getProject(selectedProjectId).then((p) => {
          if (!cancelled) setDestination(p);
        }),
      );
    } else {
      setDestination(null);
    }
    Promise.all(jobs).then(() => { if (!cancelled) setError(null); })
      .catch((err: unknown) =>
        !cancelled && setError(localizedErrorMessage(err, strings)),
      )
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, retry]);

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
    () =>
      sortProjectDestinations(projects ?? [], locale).map((project) => ({
        id: project.id,
        title: project.title,
      })),
    [locale, projects],
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

  const submit = async () => {
    if (loading || error !== null || (selectedProjectId !== null && !currentDestination)) return;
    const sourceRead = taskActions.captureTargetRead(task.id);
    const destinationRead = selectedProjectId === null ? null : projectActions.captureTargetRead(selectedProjectId);
    const isCurrent = () => taskActions.isCurrentTargetRead(sourceRead) &&
      (!destinationRead || projectActions.isCurrentTargetRead(destinationRead));
    setSaving(true);
    setSubmitError(null);
    try {
      await api.moveTask(task.id, {
        projectId: selectedProjectId,
        parentTaskId: selectedParentId,
        expectedRevision: task.revision,
      });
      if (!isCurrent()) return;
      // Only a move the server accepted is worth offering as a shortcut.
      rememberDestination("project", selectedProjectId);
      rememberDestination("parent", selectedParentId);
      bump();
      onClose();
    } catch (err) {
      if (!isCurrent()) return;
      if (isStaleWriteConflict(err)) bump();
      setSubmitError(localizedErrorMessage(err, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet {...presentation} title={strings.moveProjectTitle} onClose={onClose} labelledBy="move-task-title">
      <p className="text-muted">{task.title}</p>
      <p className="text-muted">{strings.subtreeHint}</p>
      {loading && projects === null ? (
        <LoadingState />
      ) : (
        <div className="stack">
          {error || unavailable ? <ReadErrorState resource={strings.project}
            error={error ?? strings.workflowTargetUnavailable} refreshError={null}
            loading={loading} refreshing={false} reload={() => setRetry(value => value + 1)} /> : null}
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
          <DestinationPicker
            kind="parent"
            label={strings.selectParent}
            options={parentOptions}
            value={selectedParentId}
            onChange={setSelectedParentId}
            noneLabel={strings.noParent}
          />
          {submitError ? (
            <p className="text-muted" role="alert">
              {strings.moveFailed}: {submitError}
            </p>
          ) : null}
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>
              {strings.cancel}
            </button>
            <button type="button" className="btn btn-primary btn-block" disabled={saving || loading || unavailable || error !== null} onClick={() => void submit()}>
              {strings.moveHere}
            </button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
