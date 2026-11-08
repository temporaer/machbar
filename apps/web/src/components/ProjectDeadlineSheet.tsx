import { useEffect, useRef, useState } from "react";
import { isCancelledError } from "@tanstack/react-query";
import type { Project } from "@machbar/shared";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { useProjectActions } from "../lib/useProjectActions";
import { BottomSheet, type BottomSheetPresentationProps } from "./BottomSheet";
import { HumanDateInput } from "./HumanDateInput";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import {
  projectActivationResolutionFromPrompt,
  projectActivationPromptFromSnapshot,
  projectActivationTargetIds,
  refreshProjectActivationPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";
import type { ProjectReadToken } from "../lib/projectQueries";
import type { ProjectActivationResolution } from "@machbar/shared";
import type { ProjectDetail } from "../lib/api";
import { ReadErrorState } from "./AsyncStates";

/** Bottom sheet for a project's deadline. */
export function ProjectDeadlineSheet({
  story,
  onClose,
  onSave,
  authoritativeProject = null,
  qualifiedReads,
  ...presentation
}: {
  story: Project & Partial<Pick<ProjectDetail, "ancestors">>;
  onClose: () => void;
  onSave: (patch: { dueDate: string | null; activationResolution?: ProjectActivationResolution; expectedRevision?: number }) => Promise<void>;
  authoritativeProject?: ProjectDetail | null;
  qualifiedReads?: ReadonlyMap<number, ProjectReadToken>;
} & BottomSheetPresentationProps) {
  const strings = useStrings();
  const projectActions = useProjectActions();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState(story.dueDate ?? "");
  const promptReads = useRef(new Map<number, ProjectReadToken>());
  const openingReads = useRef<ReadonlyMap<number, ProjectReadToken> | null>(null);
  const readIds = (value: ProjectActivationPrompt | null = null) => [...new Set([
    ...projectActivationTargetIds(story.id, story.ancestors),
    ...projectActivationTargetIds(story.id, authoritativeProject?.ancestors),
    ...(value?.expectedProjects.map(project => project.projectId) ?? []),
    ...(value?.projects.map(project => project.projectId) ?? []),
  ])].filter(id => id !== story.id);
  const capturePromptReads = (value: ProjectActivationPrompt | null = null, fresh = false) => {
    const reads = new Map<number, ProjectReadToken>();
    for (const id of readIds(value)) {
      const read = fresh || !promptReads.current.has(id)
        ? projectActions.captureTargetRead(id)
        : promptReads.current.get(id)!;
      promptReads.current.set(id, read);
      reads.set(id, read);
    }
    return reads;
  };
  if (!openingReads.current) {
    openingReads.current = qualifiedReads ? new Map(qualifiedReads) : capturePromptReads();
    promptReads.current = new Map(openingReads.current);
  }
  const bindPrompt = (
    value: ProjectActivationPrompt,
    isTargetCurrent: () => boolean,
    reads: ReadonlyMap<number, ProjectReadToken>,
  ): ProjectActivationPrompt => {
    const ids = readIds(value);
    const captured = ids.every(id => reads.has(id));
    return {
      ...value,
      ...(!captured ? { readUnavailable: true } : {}),
      isCurrentRead: () => captured && isTargetCurrent() && ids.every(id => {
        const read = reads.get(id)!;
        return projectActions.isCurrentTargetRead(read) && projectActions.isTargetReadable(id);
      }),
    };
  };
  const unavailablePrompt = (previous: ProjectActivationPrompt | null) => {
    if (!previous?.projects.length && readIds(previous).length === 0) return previous;
    return {
      ...(previous ?? { projects: [], expectedProjects: [], selectedDrivers: {}, nextActionTitle: "" }),
      readUnavailable: true,
    };
  };
  const [activationPrompt, setActivationPrompt] = useState<ProjectActivationPrompt | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const promptRef = useRef(activationPrompt);
  promptRef.current = activationPrompt;
  const recover = async () => {
    if (recoveryLoading) return;
    const prompt = promptRef.current;
    const qualifiedReads = capturePromptReads(prompt, true);
    const release = readIds(prompt).map(id => projectActions.pauseRetention(id));
    setRecoveryLoading(true);
    setRecoveryError(null);
    try {
      for (const id of readIds(prompt)) {
        const received = await projectActions.readProject(id);
        if (!projectActions.isCurrentTargetRead(received.read) ||
          !projectActions.isCurrentTargetRead(qualifiedReads.get(id)!)) {
          throw new Error(strings.workflowTargetUnavailable);
        }
      }
      const received = await projectActions.readProject(story.id);
      if (!projectActions.isCurrentTargetRead(received.read)) throw new Error(strings.workflowTargetUnavailable);
      if (!received.value.activationDecisionSnapshot) {
        setActivationPrompt(previous => unavailablePrompt(previous));
      } else {
        const merged = projectActivationPromptFromSnapshot(
          received.value.activationDecisionSnapshot,
          promptRef.current,
          story.id,
          promptRef.current?.targetRevision,
        );
        setActivationPrompt(bindPrompt(merged, () => projectActions.isCurrentTargetRead(received.read), qualifiedReads));
      }
    } catch (cause) {
      if (!isCancelledError(cause)) setRecoveryError(localizedErrorMessage(cause, strings));
    } finally {
      release.forEach(done => done());
      setRecoveryLoading(false);
    }
  };
  const consumedAuthority = useRef<ProjectDetail | null>(null);
  useEffect(() => {
    if (saving || !authoritativeProject || consumedAuthority.current === authoritativeProject) return;
    consumedAuthority.current = authoritativeProject;
    if (authoritativeProject.id !== story.id || !projectActions.isCurrentProjectRead(authoritativeProject)) return;
    if (!authoritativeProject.activationDecisionSnapshot) {
      setActivationPrompt(unavailablePrompt);
      return;
    }
    setActivationPrompt(previous => {
      if (!previous) return previous;
      const merged = projectActivationPromptFromSnapshot(authoritativeProject.activationDecisionSnapshot ?? null, previous, story.id, previous.targetRevision);
      if (merged === previous) return previous;
      return bindPrompt(merged, () => projectActions.isCurrentProjectRead(authoritativeProject), new Map(openingReads.current ?? promptReads.current));
    });
  }, [authoritativeProject, saving]);
  const unavailable = activationPrompt?.readUnavailable || (activationPrompt?.isCurrentRead && !activationPrompt.isCurrentRead());

  const commit = async (
    patch: { dueDate: string | null; activationResolution?: ProjectActivationResolution },
  ) => {
    if (saving || (activationPrompt && unavailable)) return;
    const continuation = projectActions.captureTargetRead(story.id);
    const requestReads = capturePromptReads(activationPrompt);
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (cause) {
      if (!projectActions.isCurrentTargetRead(continuation)) return;
      const read = projectActions.captureTargetRead(story.id);
      const prompt = await refreshProjectActivationPrompt(cause, story.id, activationPrompt, "commitment", projectActions.getProject,
        () => projectActions.isCurrentTargetRead(read), activationPrompt?.targetRevision);
      if (!projectActions.isCurrentTargetRead(continuation)) return;
      if (prompt) setActivationPrompt(bindPrompt(prompt, () => projectActions.isCurrentTargetRead(read), requestReads));
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      {...presentation}
      title={strings.projectDeadlineTitle}
      onClose={() => {
        if (!saving) onClose();
      }}
      labelledBy="project-deadline-title"
    >
      <div className="stack">
        <p className="text-muted">{story.title}</p>
        <div className="field">
          <label htmlFor="story-due">{strings.due}</label>
          <HumanDateInput
            id="story-due"
            value={dueDate}
            onChange={(date) => {
              setDueDate(date ?? "");
              void commit({ dueDate: date });
            }}
            disabled={saving}
          />
        </div>
        {activationPrompt ? (
          <>
            {!unavailable ? <ProjectActivationDecisionFields prompt={activationPrompt} disabled={saving} onChange={setActivationPrompt} /> : null}
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || unavailable || projectActivationResolutionFromPrompt(activationPrompt) === null}
              onClick={() => void commit({
                dueDate: dueDate || null,
                ...(activationPrompt.targetRevision !== undefined || unavailable
                  ? { expectedRevision: unavailable ? story.revision : activationPrompt.targetRevision }
                  : {}),
                ...(projectActivationResolutionFromPrompt(activationPrompt)
                  ? { activationResolution: projectActivationResolutionFromPrompt(activationPrompt)! }
                  : {}),
              })}
            >
              {strings.save}
            </button>
          </>
        ) : null}
        {unavailable && !presentation.headerStatus ? <ReadErrorState resource={strings.project}
          error={recoveryError ?? strings.workflowTargetUnavailable} refreshError={null}
          loading={recoveryLoading} refreshing={false} reload={() => void recover()} /> : null}
        {error ? <p role="alert" style={{ color: "var(--color-danger)" }}>{error}</p> : null}
        <button type="button" className="btn" onClick={onClose} disabled={saving}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
