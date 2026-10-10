import { useState } from "react";
import type { Task } from "@machbar/shared";
import { useTaskBreakdown } from "../lib/useTaskBreakdown";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

export function TaskBreakdownSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const [instruction, setInstruction] = useState("");
  const { start, pending, error } = useTaskBreakdown();
  return (
    <BottomSheet title={strings.taskBreakdown} onClose={() => !pending && onClose()}>
      <form className="stack" onSubmit={(event) => {
        event.preventDefault();
        void start(task, instruction).then((started) => { if (started) onClose(); });
      }}>
        <p>{task.title}</p>
        <p className="text-muted">{strings.taskBreakdownHelp}</p>
        <label className="stack">
          <span>{strings.taskBreakdownInstructions}</span>
          <textarea autoFocus rows={5} maxLength={2000} value={instruction}
            placeholder={strings.taskBreakdownPlaceholder} disabled={pending}
            onChange={(event) => setInstruction(event.target.value)} />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <div className="row">
          <button type="button" className="btn" disabled={pending} onClick={onClose}>{strings.cancel}</button>
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {strings.taskBreakdownGenerate}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
