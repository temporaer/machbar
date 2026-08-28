import { useState } from "react";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { BottomSheet } from "./BottomSheet";
import { MemberChoiceGroup } from "./MemberChoiceGroup";

/**
 * The one focused "who is responsible for this task?" popup used everywhere
 * a targeted assignment is offered — the `TaskRow` chip strip (via
 * `TaskQuickActionSheet`) and the refinement list's `Zuweisen` chip.
 *
 * Deliberately *not* the full `TaskDetailSheet`: assigning is a single-field
 * decision, so opening the whole editor (with its title/notes/tags/
 * dependencies/subtasks sections and its own loading round trip) would bury
 * that one control. The caller supplies the mutation via `onAssign`, so each
 * surface keeps its own optimistic/retention behaviour
 * (`useTaskActions.quickUpdate` vs `useRefinementActions.assignOwner`) while
 * the markup, labels and error handling stay identical.
 *
 * The picker itself is a `MemberChoiceGroup` of tap chips rather than a
 * `<select>`, so the whole household is one thumb-tap away.
 */
export function AssignOwnerSheet({
  title,
  groupId,
  currentOwnerId,
  onClose,
  onAssign,
}: {
  title: string;
  /** Unique id linking the `Zuständig` group label to its chips (rows stack). */
  groupId: string;
  currentOwnerId: number | null;
  onClose: () => void;
  onAssign: (ownerMemberId: number | null) => Promise<void>;
}) {
  const strings = useStrings();
  const { members } = useIdentity();
  const [ownerId, setOwnerId] = useState<number | null>(currentOwnerId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onAssign(ownerId);
      onClose();
    } catch (err) {
      setError(localizedErrorMessage(err, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet title={title} onClose={onClose}>
      <div className="stack task-quick-action-sheet">
        <MemberChoiceGroup
          label={strings.owner}
          idPrefix={groupId}
          members={members}
          value={ownerId}
          onChange={setOwnerId}
          unassignedLabel={strings.shared}
          disabled={saving}
          autoFocus
        />

        {error ? (
          <div className="task-row-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="row">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            {strings.close}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={saving}
          >
            {strings.saveChanges}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
