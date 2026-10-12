import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { BottomSheet } from "./BottomSheet";

/**
 * Focused `task.structure` workflow — the fixed row rail's `Struktur`
 * button. It offers AI clarification, splitting, moving, and role conversion.
 * Each tile dispatches its semantic command; `useWorkItemCommands()` decides
 * which workflow opens next, so this sheet never renders one of its own.
 */
export function TaskStructureSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const dispatch = useWorkItemCommands();

  return (
    <BottomSheet title={`${strings.structure}: ${task.title}`} onClose={onClose}>
      <div className="stack">
        {task.kind !== "reference" ? (
          <button type="button" className="btn" onClick={() => dispatch({ type: "task.refine", taskId: task.id })}>
            {strings.workRefinement}
          </button>
        ) : null}
        {task.kind !== "reference" ? (
          <button
            type="button"
            className="btn"
            onClick={() => dispatch({ type: "task.split", taskId: task.id })}
          >
            {strings.structureSplit}
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          onClick={() => dispatch({ type: "task.changeProject", taskId: task.id })}
        >
          {strings.structureMove}
        </button>
        {task.kind !== "reference" ? (
          <button
            type="button"
            className="btn"
            onClick={() => dispatch({ type: "task.convertToProject", taskId: task.id })}
          >
            {strings.structureConvertToProject}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
