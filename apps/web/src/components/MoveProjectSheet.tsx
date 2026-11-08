import { useEffect, useState } from "react";
import { isCancelledError, useIsFetching } from "@tanstack/react-query";
import { api, type ProjectWithActions } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useProjectActions, useProjectDetailQuery } from "../lib/useProjectActions";
import { localizedErrorMessage, isStaleWriteConflict } from "../lib/errorMessage";
import { projectActivationTargetIds, projectActivationPromptFromError, projectActivationResolutionFromPrompt, type ProjectActivationPrompt } from "../lib/projectActivationResolution";
import { rememberDestination } from "../lib/recentDestinations";
import { BottomSheet, type BottomSheetPresentationProps } from "./BottomSheet";
import { DestinationPicker } from "./DestinationPicker";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import { ReadErrorState } from "./AsyncStates";

/** Focused story.move workflow: selection and activation decisions remain local until one commit. */
export function MoveProjectSheet({ story, onClose, ...presentation }: { story: ProjectWithActions; onClose: () => void } & BottomSheetPresentationProps) {
  const strings = useStrings();
  const projectActions = useProjectActions();
  const [projects, setProjects] = useState<ProjectWithActions[] | null>(null);
  const [parentId, setParentId] = useState<number | null>(story.parentId);
  const sourceQuery = useProjectDetailQuery(story.id);
  const destinationQuery = useProjectDetailQuery(parentId ?? -1, parentId !== null);
  const source = sourceQuery.data && projectActions.isCurrentProjectRead(sourceQuery.data) ? sourceQuery.data : null;
  const destination = destinationQuery.data && destinationQuery.data.id === parentId &&
    projectActions.isCurrentProjectRead(destinationQuery.data) ? destinationQuery.data : null;
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<ProjectActivationPrompt | null>(null);
  const [projectReadFailure, setFailedProjectRead] = useState<{ id: number; error: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const loadingProjects = projects === null || loading;
  const loadingRead = sourceQuery.loading || sourceQuery.refreshing ||
    (parentId !== null && (destinationQuery.loading || destinationQuery.refreshing));
  const load = async () => {
    await Promise.all([
      projectActions.getProject(story.id),
      ...(parentId === null ? [] : [projectActions.getProject(parentId)]),
    ]);
    const choices = await api.getProjects();
    setProjects(choices);
  };
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getProjects().then(choices => {
      if (!cancelled) { setProjects(choices); setLoadError(null); }
    }).catch((cause) => { if (!cancelled) setLoadError(localizedErrorMessage(cause, strings)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    if (retry > 0) {
      sourceQuery.reload();
      if (parentId !== null) destinationQuery.reload();
    }
    return () => { cancelled = true; };
  }, [story.id, strings, retry]);
  const qualifiedAffectedIds = source && (parentId === null || destination)
    ? new Set([...projectActivationTargetIds(source.id, source.ancestors),
      ...projectActivationTargetIds(destination?.id, destination?.ancestors)])
    : null;
  const failedProjectRead = projectReadFailure &&
    (!qualifiedAffectedIds || qualifiedAffectedIds.has(projectReadFailure.id)) ? projectReadFailure : null;
  const retryingRelevantProject = useIsFetching({
    queryKey: failedProjectRead
      ? projectActions.queryKey(failedProjectRead.id)
      : ["projects", "no-relevant-project-retry"],
    exact: true,
  }) > 0;
  const isLoading = loadingProjects || loadingRead || retryingRelevantProject;
  const resolution = prompt ? projectActivationResolutionFromPrompt(prompt) : null;
  const promptUnavailable = prompt?.readUnavailable || (prompt?.isCurrentRead && !prompt.isCurrentRead());
  const refreshingProject = sourceQuery.refreshError ?? destinationQuery.refreshError;
  const projectReadError = loadError ?? failedProjectRead?.error ?? sourceQuery.error ?? destinationQuery.error ??
    (promptUnavailable || (projects !== null && (!source || (parentId !== null && !destination)))
      ? strings.workflowTargetUnavailable : null);
  const retryProjectRead = async () => {
    if (!failedProjectRead) { setRetry(value => value + 1); return; }
    if (busy || isLoading) return;
    if (!source || (parentId !== null && !destination) || loadError !== null) {
      setRetry(value => value + 1);
      return;
    }
    const isCurrent = () => projectActions.isCurrentProjectRead(source) && (!destination || projectActions.isCurrentProjectRead(destination));
    try {
      const latest = await projectActions.getProject(failedProjectRead.id, cause => {
        if (isCurrent()) setFailedProjectRead(current => current === failedProjectRead
          ? { id: failedProjectRead.id, error: localizedErrorMessage(cause, strings) } : current);
      });
      if (isCurrent() && projectActions.isCurrentProjectRead(latest)) {
        setFailedProjectRead(current => current === failedProjectRead ? null : current);
      }
    } catch { /* Keep the matching read failure and the selected destination. */ }
  };
  const submit = async () => {
    if (!source || busy || isLoading || loadError !== null || failedProjectRead !== null || (parentId !== null && !destination)) return;
    const affectedIds = new Set([...projectActivationTargetIds(source.id, source.ancestors),
      ...projectActivationTargetIds(destination?.id, destination?.ancestors)]);
    const continuations = [...affectedIds].map(projectActions.captureTargetRead);
    const isCurrent = () => continuations.every(projectActions.isCurrentTargetRead);
    setBusy(true);
    setError(null);
    try {
      for (const id of affectedIds) {
        if (!projectActions.isTargetReadable(id)) {
          const current = await projectActions.getProject(id, cause => {
            if (isCurrent()) setFailedProjectRead({ id, error: localizedErrorMessage(cause, strings) });
          });
          if (!isCurrent() || !projectActions.isCurrentProjectRead(current)) return;
        }
      }
      const revisions = new Map((source.hierarchyRevisions ?? []).map((entry) => [entry.id, entry.revision]));
      // Destination ancestors are affected by commitment activation; unrelated descendants are not.
      for (const entry of [destination, ...(destination?.ancestors ?? [])]) {
        if (entry?.revision !== undefined) revisions.set(entry.id, entry.revision);
      }
      await projectActions.moveProject(story.id, { parentId, expectedRevision: source.revision,
        expectedHierarchyRevisions: [...revisions].map(([id, revision]) => ({ id, revision })),
        ...(resolution ? { activationResolution: resolution } : {}) });
      if (!isCurrent()) return;
      rememberDestination("project", parentId);
      onClose();
    } catch (cause) {
      if (!isCurrent()) return;
      if (isCancelledError(cause)) return;
      const nextPrompt = projectActivationPromptFromError(cause, prompt);
      if (nextPrompt) setPrompt({ ...nextPrompt, isCurrentRead: () => isCurrent() &&
        nextPrompt.projects.every(project => affectedIds.has(project.projectId)) &&
        nextPrompt.expectedProjects.every(project => affectedIds.has(project.projectId)) });
      if (isStaleWriteConflict(cause)) {
        setPrompt(previous => previous ? { ...previous, readUnavailable: true } : previous);
        try { await load(); } catch { /* Retain the destination and decisions for retry. */ }
      }
      if (!isCurrent()) return;
      setError(localizedErrorMessage(cause, strings));
    } finally { setBusy(false); }
  };
  const excluded = new Set([story.id, ...(source?.hierarchyRevisions ?? []).filter((entry) => !source?.ancestors?.some((parent) => parent.id === entry.id)).map((entry) => entry.id)]);
  return <BottomSheet {...presentation} title={strings.moveProjectTitle} onClose={() => { if (!busy) onClose(); }}>
    <div className="stack">
      <p className="text-muted">{story.title}</p>
      <p className="text-muted">{strings.projectSubtreeHint}</p>
      {projects !== null ? <DestinationPicker kind="project" label={strings.selectProject}
        options={projects.filter((project) => project.scope === story.scope && !excluded.has(project.id)).map(({ id, title }) => ({ id, title }))}
        disabled={busy} value={parentId} onChange={(id) => { setParentId(id); setPrompt(null); }} noneLabel={strings.noProject} /> : null}
      {source?.status === "active" && destination?.status === "backlog" ? <p className="text-muted">{strings.projectMoveActivationHint}</p> : null}
      {prompt ? <ProjectActivationDecisionFields prompt={prompt} disabled={busy} onChange={setPrompt} /> : null}
      {error ? <p role="alert">{strings.moveFailed}: {error}</p> : null}
      {projectReadError || refreshingProject ? <ReadErrorState resource={strings.project}
        error={projectReadError} refreshError={refreshingProject} loading={isLoading} refreshing={false}
        reload={() => void retryProjectRead()} /> : null}
      <button type="button" className="btn btn-primary" disabled={busy || isLoading || loadError !== null || failedProjectRead !== null || !source || (parentId !== null && !destination) || (!!prompt && !promptUnavailable && !resolution)} onClick={() => void submit()}>{strings.moveHere}</button>
      <button type="button" className="btn" disabled={busy} onClick={onClose}>{strings.cancel}</button>
    </div>
  </BottomSheet>;
}
