import { useState } from "react";
import type { Member } from "@machbar/shared";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet, type BottomSheetPresentationProps } from "./BottomSheet";
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
  onCancel,
  onSelect,
  ...presentation
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
  onCancel?: () => void;
  onSelect: (memberId: number | null) => Promise<void | boolean>;
} & BottomSheetPresentationProps) {
  const strings = useStrings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (memberId: number | null) => {
    if (saving) return;
    if (memberId === value && valueIsExplicit) {
      (onCancel ?? onClose)();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const accepted = await onSelect(memberId);
      if (accepted !== false) onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet {...presentation} title={title} onClose={() => {
      if (!saving) (onCancel ?? onClose)();
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
        <button type="button" className="btn" onClick={onCancel ?? onClose} disabled={saving}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
