import { useEffect, useState } from "react";
import { api, type ProjectDetail, type ProjectWithActions } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useRefresh } from "../lib/refresh";
import { localizedErrorMessage, isStaleWriteConflict } from "../lib/errorMessage";
import { projectActivationPromptFromError, projectActivationResolutionFromPrompt, type ProjectActivationPrompt } from "../lib/projectActivationResolution";
import { rememberDestination } from "../lib/recentDestinations";
import { BottomSheet } from "./BottomSheet";
import { DestinationPicker } from "./DestinationPicker";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";

/** Focused story.move workflow: selection and activation decisions remain local until one commit. */
export function MoveProjectSheet({ story, onClose }: { story: ProjectWithActions; onClose: () => void }) {
  const strings = useStrings();
  const { bump } = useRefresh();
  const [source, setSource] = useState<ProjectDetail | null>(null);
  const [projects, setProjects] = useState<ProjectWithActions[]>([]);
  const [parentId, setParentId] = useState<number | null>(story.parentId);
  const [destination, setDestination] = useState<ProjectDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<ProjectActivationPrompt | null>(null);
  const load = async () => {
    const [current, choices] = await Promise.all([api.getProject(story.id), api.getProjects()]);
    setSource(current);
    setProjects(choices);
  };
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getProject(story.id), api.getProjects()]).then(([current, choices]) => {
      if (!cancelled) { setSource(current); setProjects(choices); }
    }).catch((cause) => { if (!cancelled) setError(localizedErrorMessage(cause, strings)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [story.id, strings]);
  useEffect(() => {
    let cancelled = false;
    setDestination(null);
    if (parentId !== null) api.getProject(parentId).then((current) => {
      if (!cancelled) setDestination(current);
    }).catch((cause) => { if (!cancelled) setError(localizedErrorMessage(cause, strings)); });
    return () => { cancelled = true; };
  }, [parentId, strings]);
  const resolution = prompt ? projectActivationResolutionFromPrompt(prompt) : null;
  const submit = async () => {
    if (!source || busy || (parentId !== null && !destination)) return;
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
      rememberDestination("project", parentId);
      bump();
      onClose();
    } catch (cause) {
      const nextPrompt = projectActivationPromptFromError(cause, prompt);
      if (nextPrompt) setPrompt(nextPrompt);
      if (isStaleWriteConflict(cause)) {
        bump();
        try { await load(); if (parentId !== null) setDestination(await api.getProject(parentId)); } catch { /* Retain the destination and decisions for retry. */ }
      }
      setError(localizedErrorMessage(cause, strings));
    } finally { setBusy(false); }
  };
  const excluded = new Set([story.id, ...(source?.hierarchyRevisions ?? []).filter((entry) => !source?.ancestors?.some((parent) => parent.id === entry.id)).map((entry) => entry.id)]);
  return <BottomSheet title={strings.moveProjectTitle} onClose={() => { if (!busy) onClose(); }}>
    <div className="stack">
      <p className="text-muted">{story.title}</p>
      <p className="text-muted">{strings.projectSubtreeHint}</p>
      {!loading ? <DestinationPicker kind="project" label={strings.selectProject}
        options={projects.filter((project) => project.scope === story.scope && !excluded.has(project.id)).map(({ id, title }) => ({ id, title }))}
        disabled={busy} value={parentId} onChange={(id) => { setParentId(id); setPrompt(null); }} noneLabel={strings.noProject} /> : null}
      {source?.status === "active" && destination?.status === "backlog" ? <p className="text-muted">{strings.projectMoveActivationHint}</p> : null}
      {prompt ? <ProjectActivationDecisionFields prompt={prompt} disabled={busy} onChange={setPrompt} /> : null}
      {error ? <p role="alert">{strings.moveFailed}: {error}</p> : null}
      <button type="button" className="btn btn-primary" disabled={busy || loading || !source || (parentId !== null && !destination) || (!!prompt && !resolution)} onClick={() => void submit()}>{strings.moveHere}</button>
      <button type="button" className="btn" disabled={busy} onClick={onClose}>{strings.cancel}</button>
    </div>
  </BottomSheet>;
}
