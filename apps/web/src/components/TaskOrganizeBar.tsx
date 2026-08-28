import type { Task } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import type { OrganizeDirection } from "../lib/useOutlineOrganize";

export interface TaskOrganizeBarProps {
  task: Task;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canIndent: boolean;
  canOutdent: boolean;
  busy: boolean;
  onMove: (direction: OrganizeDirection) => void;
  onRefile: () => void;
  onClose: () => void;
}

/**
 * The single, non-gesture way to restructure the outline: exactly one bar
 * for the currently selected task instead of a control panel repeated under
 * every row. It is reachable purely by keyboard (the row's drag handle is a
 * button that selects the task) and mirrors the drag gestures one-to-one —
 * vertical reorder, indent/outdent by one level — plus the searchable
 * refile sheet for destinations that are nowhere near on screen.
 *
 * Buttons stay enabled while a move is in flight (the outline ignores a
 * second one anyway): disabling the button that currently has focus would
 * throw keyboard users back to the document body mid-sequence.
 */
export function TaskOrganizeBar({
  task,
  canMoveUp,
  canMoveDown,
  canIndent,
  canOutdent,
  busy,
  onMove,
  onRefile,
  onClose,
}: TaskOrganizeBarProps) {
  const strings = useStrings();
  return (
    <div className="task-organize-bar" role="toolbar" aria-label={strings.organizeControls} aria-busy={busy}>
      <span className="task-organize-bar-title">{task.title}</span>
      <div className="task-organize-bar-actions">
        <button
          type="button"
          className="btn btn-sm"
          aria-label={strings.moveUp}
          title={strings.moveUp}
          disabled={!canMoveUp}
          onClick={() => onMove("up")}
        >
          ↑
        </button>
        <button
          type="button"
          className="btn btn-sm"
          aria-label={strings.moveDown}
          title={strings.moveDown}
          disabled={!canMoveDown}
          onClick={() => onMove("down")}
        >
          ↓
        </button>
        <button
          type="button"
          className="btn btn-sm"
          aria-label={strings.indent}
          title={strings.indent}
          disabled={!canIndent}
          onClick={() => onMove("indent")}
        >
          →
        </button>
        <button
          type="button"
          className="btn btn-sm"
          aria-label={strings.outdent}
          title={strings.outdent}
          disabled={!canOutdent}
          onClick={() => onMove("outdent")}
        >
          ←
        </button>
        <button type="button" className="btn btn-sm" onClick={onRefile}>
          {strings.refile}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
          {strings.exitOrganizeMode}
        </button>
      </div>
    </div>
  );
}
