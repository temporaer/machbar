import { useState } from "react";
import type { Project, ProjectActivationResolution } from "@machbar/shared";
import type { ProjectDetail, ProjectWorkflowAction } from "../lib/api";
import { hasApiErrorCode, isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import {
  projectActivationPromptFromSnapshot,
  projectActivationResolutionFromPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import { BottomSheet } from "./BottomSheet";

type ActivationDraft = Pick<ProjectActivationPrompt, "selectedDrivers" | "nextActionTitle">;

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
  loading,
  action,
  readError,
  requirementsChanged,
  onRetry,
  onRequirementsChanged,
  isCurrent,
  onClose,
  onActivationSuccess,
  onActivate,
}: {
  story: ProjectDetail | null;
  loading: boolean;
  action: Extract<ProjectWorkflowAction, "activate" | "reopen">;
  readError: string | null;
  requirementsChanged: boolean;
  onRetry: () => void;
  onRequirementsChanged: () => void;
  isCurrent: () => boolean;
  onClose: () => void;
  onActivationSuccess: () => void;
  onActivate: (ownerMemberId: number | null, resolution: ProjectActivationResolution, expectedRevision?: number) => Promise<void>;
}) {
  const strings = useStrings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ActivationDraft>({ selectedDrivers: {}, nextActionTitle: "" });
  const prompt = story ? activationPrompt(story, draft) : null;
  const resolution = prompt ? projectActivationResolutionFromPrompt(prompt) : null;

  const submit = async () => {
    if (saving || !story || !prompt) return;
    if (!resolution) {
      setError(strings.activationDecisionHint);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const targetRevision = prompt.expectedProjects.find((entry) => entry.projectId === story.id)?.revision ?? prompt.targetRevision;
      await onActivate(selectedDriver(story, prompt), resolution, targetRevision);
      if (isCurrent()) onActivationSuccess();
    } catch (cause) {
      if (!isCurrent()) return;
      if (isStaleWriteConflict(cause) || hasApiErrorCode(cause, "project_commitment_resolution_required")) {
        onRequirementsChanged();
        return;
      }
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
        {story && prompt ? <>
        <p className="text-muted">{story.title}</p>
        {requirementsChanged ? <p role="alert" className="task-row-error">{strings.activationRequirementsChanged}</p> : null}
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
        </> : loading ? <p role="status">{strings.loading}</p> : null}
        <div className="row">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>{strings.cancel}</button>
          <button type="button" className="btn btn-primary" disabled={saving || resolution === null} onClick={() => void submit()}>
            {action === "reopen" ? strings.reopen : strings.activateStory}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
