import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { BottomSheet } from "./BottomSheet";

/**
 * Shape is deliberately separate from lifecycle. Existing project conversion
 * remains the guarded canonical handoff; task-to-reference conversion has no
 * supported mutation path yet, so that choice is shown without inventing one.
 */
export function TaskShapeSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const strings = useStrings();
  const dispatch = useWorkItemCommands();

  return (
    <BottomSheet title={strings.shapeQuestion} onClose={onClose}>
      <div className="stack">
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (task.kind === "reference") {
              dispatch({ type: "task.makeAction", task });
            } else {
              onClose();
            }
          }}
        >
          <strong>{task.kind === "reference" ? strings.makeAction : strings.shapeTask}</strong>
          <span className="text-muted">{strings.shapeTaskHint}</span>
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => dispatch({ type: "task.convertToProject", taskId: task.id })}
        >
          <strong>{strings.shapeProject}</strong>
          <span className="text-muted">{strings.shapeProjectHint}</span>
        </button>
        <button type="button" className="btn" disabled title={strings.shapeReferenceUnavailable}>
          <strong>{strings.shapeReference}</strong>
          <span className="text-muted">{strings.shapeReferenceHint}</span>
        </button>
        <p className="text-muted">{strings.shapeReferenceUnavailable}</p>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
