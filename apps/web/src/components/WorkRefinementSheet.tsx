import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { WorkRefinementIntent } from "@machbar/shared";
import { api } from "../lib/api";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

export function WorkRefinementSheet({
  targetType, targetId, revision, title, onClose,
}: {
  targetType: "task" | "project"; targetId: number; revision: number; title: string; onClose: () => void;
}) {
  const strings = useStrings();
  const navigate = useNavigate();
  const [intent, setIntent] = useState<WorkRefinementIntent>("improve");
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generate = async () => {
    if (pending) return;
    setPending(true); setError(null);
    try {
      const result = await api.startWorkRefinement(targetType, targetId, {
        expectedRevision: revision, intent, ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
      });
      onClose();
      navigate(`/intake/${result.id}`);
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally { setPending(false); }
  };
  return <BottomSheet title={`${strings.workRefinement} ${title}`} onClose={onClose}>
    <div className="stack">
      <p className="muted">{strings.workRefinementHelp}</p>
      <label className="stack">
        <span>{strings.workRefinement}</span>
        <select value={intent} onChange={(event) => setIntent(event.target.value as WorkRefinementIntent)}>
          <option value="improve">{strings.workRefinementImprove}</option>
          <option value="next_action">{strings.workRefinementNextAction}</option>
          <option value="structure">{strings.workRefinementStructure}</option>
        </select>
      </label>
      <label className="stack">
        <span>{strings.taskBreakdownInstructions}</span>
        <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} maxLength={2000} placeholder={strings.workRefinementPlaceholder} />
      </label>
      {error ? <p role="alert" className="error-text">{error}</p> : null}
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void generate()}>
          {pending ? strings.loading : strings.taskBreakdownGenerate}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>{strings.cancel}</button>
      </div>
    </div>
  </BottomSheet>;
}
