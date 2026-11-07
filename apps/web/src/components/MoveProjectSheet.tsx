import { useEffect, useState } from "react";
import { api, type ProjectDetail, type ProjectWithActions } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useProjectActions } from "../lib/useProjectActions";
import { useRefresh } from "../lib/refresh";
import { localizedErrorMessage, isStaleWriteConflict } from "../lib/errorMessage";
import { projectActivationPromptFromError, projectActivationResolutionFromPrompt, type ProjectActivationPrompt } from "../lib/projectActivationResolution";
import { rememberDestination } from "../lib/recentDestinations";
import { BottomSheet, type BottomSheetPresentationProps } from "./BottomSheet";
import { DestinationPicker } from "./DestinationPicker";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import { ReadErrorState } from "./AsyncStates";

/** Focused story.move workflow: selection and activation decisions remain local until one commit. */
export function MoveProjectSheet({ story, onClose, ...presentation }: { story: ProjectWithActions; onClose: () => void } & BottomSheetPresentationProps) {
  const strings = useStrings();
  const projectActions = useProjectActions();
  const { bump } = useRefresh();
  const [sourceRead, setSource] = useState<ProjectDetail | null>(null);
  const source = sourceRead?.id === story.id && projectActions.isCurrentProjectRead(sourceRead) ? sourceRead : null;
  const [projects, setProjects] = useState<ProjectWithActions[]>([]);
  const [parentId, setParentId] = useState<number | null>(story.parentId);
  const [destinationRead, setDestination] = useState<ProjectDetail | null>(null);
  const destination = destinationRead?.id === parentId && destinationRead && projectActions.isCurrentProjectRead(destinationRead) ? destinationRead : null;
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<ProjectActivationPrompt | null>(null);
  const [retry, setRetry] = useState(0);
  const load = async () => {
    const [current, choices] = await Promise.all([projectActions.getProject(story.id), api.getProjects()]);
    setSource(current);
    setProjects(choices);
  };
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([projectActions.getProject(story.id), api.getProjects()]).then(([current, choices]) => {
      if (!cancelled) { setSource(current); setProjects(choices); }
    }).catch((cause) => { if (!cancelled) setError(localizedErrorMessage(cause, strings)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [story.id, strings, retry]);
  useEffect(() => {
    let cancelled = false;
    setDestination(null);
    if (parentId !== null) projectActions.getProject(parentId).then((current) => {
      if (!cancelled) setDestination(current);
    }).catch((cause) => { if (!cancelled) setError(localizedErrorMessage(cause, strings)); });
    return () => { cancelled = true; };
  }, [parentId, strings, retry]);
  const resolution = prompt ? projectActivationResolutionFromPrompt(prompt) : null;
  const submit = async () => {
    if (!source || busy || (parentId !== null && !destination)) return;
    const sourceContinuation = projectActions.captureTargetRead(story.id);
    const destinationContinuation = parentId === null ? null : projectActions.captureTargetRead(parentId);
    const isCurrent = () => projectActions.isCurrentTargetRead(sourceContinuation) &&
      (!destinationContinuation || projectActions.isCurrentTargetRead(destinationContinuation));
    setBusy(true);
    setError(null);
    try {
      const revisions = new Map((source.hierarchyRevisions ?? []).map((entry) => [entry.id, entry.revision]));
      // Destination ancestors are affected by commitment activation; unrelated descendants are not.
      for (const entry of [destination, ...(destination?.ancestors ?? [])]) {
        if (entry?.revision !== undefined) revisions.set(entry.id, entry.revision);
      }
      await api.moveProject(story.id, { parentId, expectedRevision: source.revision,
        expectedHierarchyRevisions: [...revisions].map(([id, revision]) => ({ id, revision })),
        ...(resolution ? { activationResolution: resolution } : {}) });
      if (!isCurrent()) return;
      rememberDestination("project", parentId);
      bump();
      onClose();
    } catch (cause) {
      if (!isCurrent()) return;
      const nextPrompt = projectActivationPromptFromError(cause, prompt);
      if (nextPrompt) setPrompt(nextPrompt);
      if (isStaleWriteConflict(cause)) {
        bump();
        try { await load(); if (parentId !== null) setDestination(await projectActions.getProject(parentId)); } catch { /* Retain the destination and decisions for retry. */ }
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
      {!loading ? <DestinationPicker kind="project" label={strings.selectProject}
        options={projects.filter((project) => project.scope === story.scope && !excluded.has(project.id)).map(({ id, title }) => ({ id, title }))}
        disabled={busy} value={parentId} onChange={(id) => { setParentId(id); setPrompt(null); }} noneLabel={strings.noProject} /> : null}
      {source?.status === "active" && destination?.status === "backlog" ? <p className="text-muted">{strings.projectMoveActivationHint}</p> : null}
      {prompt ? <ProjectActivationDecisionFields prompt={prompt} disabled={busy} onChange={setPrompt} /> : null}
      {error ? <p role="alert">{strings.moveFailed}: {error}</p> : null}
      {!loading && (!source || (parentId !== null && !destination)) ? <ReadErrorState resource={strings.project}
        error={error ?? strings.workflowTargetUnavailable} refreshError={null} loading={loading} refreshing={false}
        reload={() => setRetry(value => value + 1)} /> : null}
      <button type="button" className="btn btn-primary" disabled={busy || loading || !source || (parentId !== null && !destination) || (!!prompt && !resolution)} onClick={() => void submit()}>{strings.moveHere}</button>
      <button type="button" className="btn" disabled={busy} onClick={onClose}>{strings.cancel}</button>
    </div>
  </BottomSheet>;
}
