import { useState } from "react";
import type { Member } from "@machbar/shared";
import { strings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { MemberChoiceGroup } from "./MemberChoiceGroup";

/**
 * Bottom sheet used both by the "Verantwortlich" chip (assign only, driver
 * may be cleared again since the story stays in the backlog) and by the
 * right-swipe/activate control when a story has no driver yet (assign +
 * activate in one step — the sheet's copy adapts via `activateHint`, but the
 * assignment itself is always a plain `ownerMemberId` pick either way).
 *
 * Like every other focused assignment popup it picks from tap chips
 * (`MemberChoiceGroup`) instead of a `<select>`. In `activateHint` mode the
 * "Niemand zugewiesen" chip is omitted entirely, because activating without
 * a driver is not a legal outcome — the API rejects it.
 */
export function AssignDriverSheet({
  members,
  currentOwnerMemberId,
  activateHint,
  onClose,
  onAssign,
}: {
  members: Member[];
  currentOwnerMemberId: number | null;
  /** When true, the sheet is being used to unblock activation (no "Niemand" option). */
  activateHint: boolean;
  onClose: () => void;
  onAssign: (ownerMemberId: number | null) => Promise<void>;
}) {
  const [selected, setSelected] = useState<number | null>(currentOwnerMemberId);
  const [saving, setSaving] = useState(false);

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
      <div className="stack">
        <MemberChoiceGroup
          label={strings.driver}
          idPrefix="assign-driver"
          members={members}
          value={selected}
          onChange={setSelected}
          unassignedLabel={activateHint ? null : strings.noDriver}
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
            disabled={saving || (activateHint && selected === null)}
            onClick={() => void submit()}
          >
            {strings.save}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
