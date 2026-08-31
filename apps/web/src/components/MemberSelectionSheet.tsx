import { useState } from "react";
import type { Member } from "@machbar/shared";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { MemberChoiceGroup } from "./MemberChoiceGroup";

export function MemberSelectionSheet({
  title,
  label,
  idPrefix,
  members,
  value,
  valueIsExplicit = true,
  unassignedLabel,
  hint,
  onClose,
  onSelect,
}: {
  title: string;
  label: string;
  idPrefix: string;
  members: Member[];
  value: number | null;
  valueIsExplicit?: boolean | undefined;
  unassignedLabel: string | null;
  hint?: string | undefined;
  onClose: () => void;
  onSelect: (memberId: number | null) => Promise<void>;
}) {
  const strings = useStrings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (memberId: number | null) => {
    if (saving) return;
    if (memberId === value && valueIsExplicit) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSelect(memberId);
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet title={title} onClose={() => {
      if (!saving) onClose();
    }}>
      <div className="stack task-quick-action-sheet">
        {hint ? <p className="text-muted">{hint}</p> : null}
        <MemberChoiceGroup
          label={label}
          idPrefix={idPrefix}
          members={members}
          value={value}
          onChange={(memberId) => void choose(memberId)}
          unassignedLabel={unassignedLabel}
          disabled={saving}
          autoFocus
        />
        {error ? <div className="task-row-error" role="alert">{error}</div> : null}
        <button type="button" className="btn" onClick={onClose} disabled={saving}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
