import { useMemo, useRef, useState } from "react";
import type { Project, ProjectActivationResolution } from "@machbar/shared";
import { ApiError, type ProjectDetail, type ProjectWorkflowAction } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import {
  projectActivationPromptFromSnapshot,
  projectActivationPromptFromError,
  projectActivationResolutionFromPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import { BottomSheet } from "./BottomSheet";

type ActivationDraft = Pick<ProjectActivationPrompt, "selectedDrivers" | "nextActionTitle">;
type ActivationRequirements = Omit<ProjectActivationPrompt, "selectedDrivers" | "nextActionTitle">;

function activationPrompt(story: ProjectDetail, draft: ActivationDraft): ProjectActivationPrompt {
  const previous = {
    projects: [],
    expectedProjects: [],
    ...draft,
  } satisfies ProjectActivationPrompt;
  if (story.directActivationDecisionSnapshot) {
    return projectActivationPromptFromSnapshot(story.directActivationDecisionSnapshot, previous);
  }
  const required = story.activationReadiness.requiredDecisions ?? [];
  const requiredDriver = required.includes("driver");
  return {
    projects: required.length > 0 ? [{
      projectId: story.id,
      title: story.title,
      revision: story.revision,
      ownerMemberId: story.ownerMemberId,
      required,
    }] : [],
    expectedProjects: [{ projectId: story.id, revision: story.revision }],
    selectedDrivers: requiredDriver && draft.selectedDrivers[story.id] !== undefined
      ? { [story.id]: draft.selectedDrivers[story.id]! }
      : {},
    nextActionTitle: draft.nextActionTitle,
  };
}

function selectedDriver(story: Project, prompt: ProjectActivationPrompt): number | null {
  return prompt.selectedDrivers[story.id] ?? story.ownerMemberId;
}

export function ProjectActivationSheet({
  story,
  action,
  loading,
  readError,
  onRetry,
  openingId,
  authorityVersion,
  readVersion,
  currentAuthorityReadVersion,
  onClose,
  onActivationSuccess,
  onActivate,
}: {
  story: ProjectDetail | null;
  action: Extract<ProjectWorkflowAction, "activate" | "reopen">;
  loading: boolean;
  readError: string | null;
  onRetry: () => void;
  openingId: number;
  authorityVersion: number;
  readVersion: number;
  currentAuthorityReadVersion: (
    authorityVersion: number,
    expectedReadVersion?: number,
    responseRevision?: number,
  ) => number | null;
  onClose: () => void;
  onActivationSuccess: () => void;
  onActivate: (ownerMemberId: number | null, resolution: ProjectActivationResolution, expectedRevision?: number) => Promise<void>;
}) {
  const strings = useStrings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ActivationDraft>({ selectedDrivers: {}, nextActionTitle: "" });
  const [promptOverride, setPromptOverride] = useState<{
    readVersion: number;
    requirements: ActivationRequirements;
  } | null>(null);
  const authorityRef = useRef({ openingId, authorityVersion, readVersion, hasAuthority: story !== null });
  authorityRef.current = { openingId, authorityVersion, readVersion, hasAuthority: story !== null };
  const currentPrompt = story ? activationPrompt(story, draft) : null;
  const prompt = story
    ? promptOverride?.readVersion === readVersion
      ? { ...promptOverride.requirements, ...draft }
      : currentPrompt
    : null;
  const resolution = useMemo(
    () => prompt ? projectActivationResolutionFromPrompt(prompt) : null,
    [prompt],
  );

  const submit = async () => {
    if (saving || !story || !prompt) return;
    if (!resolution) {
      setError(strings.commitmentResolutionHint);
      return;
    }
    const startedWith = authorityRef.current;
    setSaving(true);
    setError(null);
    try {
      const targetRevision = prompt.expectedProjects.find((entry) => entry.projectId === story.id)?.revision ?? prompt.targetRevision;
      await onActivate(selectedDriver(story, prompt), resolution, targetRevision);
      const currentAuthority = authorityRef.current;
      if (
        currentAuthority.openingId === startedWith.openingId &&
        currentAuthority.authorityVersion === startedWith.authorityVersion &&
        currentAuthority.hasAuthority &&
        currentAuthorityReadVersion(startedWith.authorityVersion) !== null
      ) onActivationSuccess();
    } catch (cause) {
      if (currentAuthorityReadVersion(startedWith.authorityVersion) === null) return;
      const commandPrompt = projectActivationPromptFromError(cause, prompt);
      if (commandPrompt) {
        const responseRevision = commandPrompt.targetRevision ??
          commandPrompt.expectedProjects.find((entry) => entry.projectId === story.id)?.revision;
        const acceptedReadVersion = currentAuthorityReadVersion(
          startedWith.authorityVersion,
          startedWith.readVersion,
          responseRevision,
        );
        if (acceptedReadVersion !== null) {
          const { selectedDrivers, nextActionTitle, ...requirements } = commandPrompt;
          setPromptOverride({ readVersion: acceptedReadVersion, requirements });
          setDraft({ selectedDrivers, nextActionTitle });
        }
      }
      if (cause instanceof ApiError && cause.code === "stale_write_conflict") onRetry();
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet title={action === "reopen" ? strings.reopen : strings.activateStory} onClose={() => {
      if (!saving) onClose();
    }}>
      <div className="stack">
        {story && prompt ? (
          <>
            <p className="text-muted">{story.title}</p>
            <ProjectActivationDecisionFields
              prompt={prompt}
              disabled={saving}
              onChange={(next) => {
                setDraft({
                  selectedDrivers: next.selectedDrivers,
                  nextActionTitle: next.nextActionTitle,
                });
              }}
            />
            {readError ? (
              <>
                <p role="alert" className="task-row-error">{readError}</p>
                <button type="button" className="btn" onClick={onRetry}>
                  {strings.retry}
                </button>
              </>
            ) : null}
            {error ? <p role="alert" className="task-row-error">{error}</p> : null}
          </>
        ) : (
          <div className="stack">
            {readError ? <p role="alert" className="task-row-error">{readError}</p> : null}
            {loading ? <p role="status" className="text-muted">{strings.loading}</p> : null}
            {readError ? (
              <button type="button" className="btn" onClick={onRetry}>
                {strings.retry}
              </button>
            ) : null}
          </div>
        )}
        <div className="row">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>{strings.cancel}</button>
          <button type="button" className="btn btn-primary" disabled={saving || !story || resolution === null} onClick={() => void submit()}>
            {action === "reopen" ? strings.reopen : strings.activateStory}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
