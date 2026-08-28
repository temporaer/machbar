import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import type { ChildPolicy, PendingAction } from "../lib/useTaskActions";

/**
 * Shown whenever a task with open descendants is marked done/cancelled.
 * The parent's fate must not silently decide the children's fate, so we
 * always ask explicitly which of the three documented policies to apply.
 */
export function ChildPolicyPrompt({
  taskTitle,
  action,
  onChoose,
  onClose,
}: {
  taskTitle: string;
  action: PendingAction;
  onChoose: (policy: ChildPolicy) => void;
  onClose: () => void;
}) {
  const strings = useStrings();
  const primaryLabel = action === "complete" ? strings.onlyThisTask : strings.onlyThisTaskCancel;
  return (
    <BottomSheet title={strings.taskHasOpenChildren} onClose={onClose} labelledBy="child-policy-title">
      <p className="text-muted">{taskTitle}</p>
      <p>{strings.openChildrenPrompt}</p>
      <div className="stack">
        <button type="button" className="btn btn-block btn-primary" onClick={() => onChoose("leave_open")}>
          {primaryLabel}
          <span className="text-muted"> – {strings.leaveChildrenOpen}</span>
        </button>
        <button type="button" className="btn btn-block" onClick={() => onChoose("complete_children")}>
          {strings.completeChildren}
        </button>
        <button type="button" className="btn btn-block btn-danger" onClick={() => onChoose("cancel_children")}>
          {strings.cancelChildren}
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={onClose}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
