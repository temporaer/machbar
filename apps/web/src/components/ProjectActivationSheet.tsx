import { useMemo, useState } from "react";
import type { Project, ProjectActivationResolution } from "@machbar/shared";
import type { ProjectWithActions, ProjectWorkflowAction } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import {
  projectActivationResolutionFromPrompt,
  refreshProjectActivationPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import { BottomSheet } from "./BottomSheet";

function activationPrompt(story: ProjectWithActions): ProjectActivationPrompt {
  const readiness = story.activationReadiness;
  const required = readiness.requiredDecisions ?? [
    ...(!readiness.hasDriver ? ["driver" as const] : []),
    ...(!(readiness.hasViableProgressPath || readiness.hasHealthyFutureWaiting || readiness.hasHealthyFutureRevisit)
      ? ["progressPath" as const]
      : []),
  ];
  return {
    projects: [{
      projectId: story.id,
      title: story.title,
      revision: story.revision,
      ownerMemberId: story.ownerMemberId,
      required,
    }],
    expectedProjects: [{ projectId: story.id, revision: story.revision }],
    selectedDrivers: {},
    nextActionTitle: "",
  };
}

function selectedDriver(story: Project, prompt: ProjectActivationPrompt): number | null {
  return prompt.selectedDrivers[story.id] ?? story.ownerMemberId;
}

export function ProjectActivationSheet({
  story,
  action,
  onClose,
  onActivate,
}: {
  story: ProjectWithActions;
  action: Extract<ProjectWorkflowAction, "activate" | "reopen">;
  onClose: () => void;
  onActivate: (ownerMemberId: number | null, resolution: ProjectActivationResolution, expectedRevision?: number) => Promise<void>;
}) {
  const strings = useStrings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(() => activationPrompt(story));
  const resolution = useMemo(() => projectActivationResolutionFromPrompt(prompt), [prompt]);

  const submit = async () => {
    if (saving) return;
    if (!resolution) {
      setError(strings.commitmentResolutionHint);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const targetRevision = prompt.expectedProjects.find((entry) => entry.projectId === story.id)?.revision ?? prompt.targetRevision;
      await onActivate(selectedDriver(story, prompt), resolution, targetRevision);
      onClose();
    } catch (cause) {
      const refreshedPrompt = await refreshProjectActivationPrompt(cause, story.id, prompt);
      if (refreshedPrompt) setPrompt(refreshedPrompt);
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
        <p className="text-muted">{story.title}</p>
        <ProjectActivationDecisionFields prompt={prompt} disabled={saving} onChange={setPrompt} />
        {error ? <p role="alert" className="task-row-error">{error}</p> : null}
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
