import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { isCapturedInboxItem } from "../lib/taskHelpers";
import { BottomSheet } from "./BottomSheet";

/**
 * Focused `task.structure` workflow — the fixed row rail's `Struktur`
 * button. Exactly the structural operations that reshape where a task
 * sits: split it into steps, move it (project and/or parent, in one
 * `MoveTaskSheet` "Verschieben …" step), or promote it into its own
 * project. Each tile only ever dispatches the underlying semantic command
 * (`task.split`/`task.changeProject`/`task.convertToProject`);
 * `useWorkItemCommands()` decides which sheet that opens next, so this
 * sheet never renders one of its own.
 */
export function TaskStructureSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const dispatch = useWorkItemCommands();
  // An unclassified captured inbox item has no children/steps yet, so
  // splitting it is meaningless (the API rejects adding children to a
  // captured item). Moving/refiling it, however, is the intended
  // clarification path — `task.changeProject` files it into a project (and
  // optionally a parent task) and atomically classifies it out of
  // `captured` in the same request, so that tile stays visible.
  const hideSplit = isCapturedInboxItem(task);

  return (
    <BottomSheet title={`${strings.structure}: ${task.title}`} onClose={onClose}>
      <div className="stack">
        {!hideSplit ? (
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
        <button
          type="button"
          className="btn"
          onClick={() => dispatch({ type: "task.convertToProject", taskId: task.id })}
        >
          {strings.structureConvertToProject}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
