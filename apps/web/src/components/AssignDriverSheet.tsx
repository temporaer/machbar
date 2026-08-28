import { useState } from "react";
import type { Member } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { MemberChoiceGroup } from "./MemberChoiceGroup";

/**
 * Bottom sheet used both by the "Verantwortlich" chip (assign only) and by
 * the right-swipe/activate control when a story has no driver yet (assign +
 * activate in one step — the sheet's copy adapts via `activateHint`, but the
 * assignment itself is always a plain `ownerMemberId` pick either way).
 *
 * Like every other focused assignment popup it picks from tap chips
 * (`MemberChoiceGroup`) instead of a `<select>`. The "Niemand zugewiesen"
 * chip is omitted whenever clearing the driver is not a legal outcome: while
 * activating (the API rejects an activation without driver) and for any
 * story that has left the backlog (`allowUnassigned={false}`; see the driver
 * invariant in `apps/api/src/domain/mutations.ts::updateProject`).
 */
export function AssignDriverSheet({
  members,
  currentOwnerMemberId,
  activateHint,
  allowUnassigned,
  onClose,
  onAssign,
}: {
  members: Member[];
  currentOwnerMemberId: number | null;
  /** When true, the sheet is being used to unblock activation (no "Niemand" option). */
  activateHint: boolean;
  /** Whether clearing the driver is legal; defaults to "yes, unless activating". */
  allowUnassigned?: boolean;
  onClose: () => void;
  onAssign: (ownerMemberId: number | null) => Promise<void>;
}) {
  const strings = useStrings();
  const [selected, setSelected] = useState<number | null>(currentOwnerMemberId);
  const [saving, setSaving] = useState(false);
  const canUnassign = allowUnassigned ?? !activateHint;

  const submit = async () => {
    setSaving(true);
    try {
      await onAssign(selected);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet title={strings.assignDriver} onClose={onClose} labelledBy="assign-driver-title">
      {activateHint ? <p className="text-muted">{strings.assignDriverToActivateHint}</p> : null}
      {!activateHint && !canUnassign ? <p className="text-muted">{strings.driverLockedHint}</p> : null}
      <div className="stack">
        <MemberChoiceGroup
          label={strings.driver}
          idPrefix="assign-driver"
          members={members}
          value={selected}
          onChange={setSelected}
          unassignedLabel={canUnassign ? strings.noDriver : null}
          disabled={saving}
          autoFocus
        />
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            {strings.cancel}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={saving || (!canUnassign && selected === null)}
            onClick={() => void submit()}
          >
            {strings.save}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
