import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { canBreakDownTask, type Task, type WorkRefinementIntent } from "@machbar/shared";
import { api } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

type WorkClarificationIntent = WorkRefinementIntent | "smaller_steps";

export function WorkClarificationSheet({
  targetType, targetId, revision, title, task, onClose,
}: {
  targetType: "task" | "project"; targetId: number; revision: number; title: string; task?: Task; onClose: () => void;
}) {
  const strings = useStrings();
  const navigate = useNavigate();
  const [intent, setIntent] = useState<WorkClarificationIntent>("improve");
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generate = async () => {
    if (pending) return;
    setPending(true); setError(null);
    try {
      const optionalInstruction = instruction.trim() ? { instruction: instruction.trim() } : {};
      const result = intent === "smaller_steps"
        ? await api.startTaskBreakdown(targetId, { expectedRevision: revision, ...optionalInstruction })
        : await api.startWorkRefinement(targetType, targetId, {
            expectedRevision: revision, intent, ...optionalInstruction,
          });
      onClose();
      navigate(`/intake/${result.id}`);
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally { setPending(false); }
  };
  const canSuggestSteps = task !== undefined && canBreakDownTask(task);
  return <BottomSheet title={`${strings.workRefinement}: ${title}`} onClose={onClose}>
    <div className="stack">
      <p className="muted">{strings.workRefinementHelp}</p>
      <label className="stack">
        <span>{strings.workRefinementIntentLabel}</span>
        <select value={intent} onChange={(event) => setIntent(event.target.value as WorkClarificationIntent)}>
          <option value="improve">{strings.workRefinementImprove}</option>
          <option value="next_action">{strings.workRefinementNextAction}</option>
          {canSuggestSteps ? <option value="smaller_steps">{strings.workRefinementSmallerSteps}</option> : null}
          <option value="structure">{strings.workRefinementStructure}</option>
        </select>
      </label>
      <label className="stack">
        <span>{strings.workRefinementInstructionLabel}</span>
        <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} maxLength={2000} placeholder={strings.workRefinementPlaceholder} />
      </label>
      {error ? <p role="alert" className="error-text">{error}</p> : null}
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void generate()}>
          {pending ? strings.loading : strings.workRefinementGenerate}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>{strings.cancel}</button>
      </div>
    </div>
  </BottomSheet>;
}
