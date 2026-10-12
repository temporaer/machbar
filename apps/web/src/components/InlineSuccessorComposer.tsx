import { useState } from "react";
import { api } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { StepComposer, type StepDraft } from "./StepComposer";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import {
  projectActivationPromptFromError,
  projectActivationResolutionFromPrompt,
  type ProjectActivationPrompt,
} from "../lib/projectActivationResolution";

function fingerprint(steps: StepDraft[]) {
  return JSON.stringify(steps);
}

export function InlineSuccessorComposer({
  predecessorId,
  onCancel,
  onCreated,
}: {
  predecessorId: number;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const strings = useStrings();
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const [busy, setBusy] = useState(false);
  const [draftSteps, setDraftSteps] = useState<StepDraft[]>([]);
  const [activationState, setActivationState] = useState<{ fingerprint: string; prompt: ProjectActivationPrompt } | null>(null);
  const requestFingerprint = fingerprint(draftSteps);
  const activationPrompt = activationState?.fingerprint === requestFingerprint ? activationState.prompt : null;
  const activationResolution = activationPrompt ? projectActivationResolutionFromPrompt(activationPrompt) : null;

  const create = async (steps: Array<{ title: string; dueDate?: string | null; scheduledDate?: string | null }>) => {
    const step = steps[0];
    if (!step) return;
    try {
      await api.createTaskSuccessor(predecessorId, {
        ...step,
        createdByMemberId: currentMemberId,
        status: "actionable",
        ...(activationResolution ? { activationResolution } : {}),
      });
      bump();
      onCreated();
    } catch (cause) {
      const prompt = projectActivationPromptFromError(cause, activationPrompt);
      if (prompt) setActivationState({ fingerprint: fingerprint(steps), prompt });
      throw cause;
    }
  };

  return (
    <div className="stack">
      {activationPrompt ? (
        <ProjectActivationDecisionFields prompt={activationPrompt} disabled={busy} onChange={(prompt) =>
          setActivationState({ fingerprint: requestFingerprint, prompt })} />
      ) : null}
      <StepComposer
        inputIdPrefix={`inline-successor-title-${predecessorId}`}
        label={strings.addSuccessor}
        placeholder={strings.successorPlaceholder}
        submitLabel={strings.save}
        onCancel={onCancel}
        onDraftChange={setDraftSteps}
        onPendingChange={setBusy}
        onSubmit={create}
        submitDisabled={activationPrompt !== null && activationResolution === null}
        singleStep
      />
    </div>
  );
}
