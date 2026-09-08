import { useState } from "react";
import type { InheritanceMode, Member } from "@machbar/shared";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import {
  TaskOwnerChoiceGroup,
  type TaskOwnerChoice,
} from "./TaskOwnerChoiceGroup";

function sameChoice(
  ownerMemberId: number | null,
  ownerInheritanceMode: InheritanceMode,
  choice: TaskOwnerChoice,
) {
  return (
    ownerMemberId === choice.ownerMemberId &&
    ownerInheritanceMode === choice.ownerInheritanceMode
  );
}

export function TaskOwnerSheet({
  title,
  taskTitle,
  members,
  ownerMemberId,
  ownerInheritanceMode,
  inheritedOwnerId,
  inheritanceSource,
  onClose,
  onSelect,
}: {
  title: string;
  taskTitle: string;
  members: Member[];
  ownerMemberId: number | null;
  ownerInheritanceMode: InheritanceMode;
  inheritedOwnerId: number | null;
  inheritanceSource: "parent" | "project" | null;
  onClose: () => void;
  onSelect: (choice: TaskOwnerChoice) => Promise<void>;
}) {
  const strings = useStrings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (choice: TaskOwnerChoice) => {
    if (saving) return;
    if (sameChoice(ownerMemberId, ownerInheritanceMode, choice)) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSelect(choice);
      onClose();
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      title={title}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="stack task-quick-action-sheet">
        <p className="text-muted">{taskTitle}</p>
        <TaskOwnerChoiceGroup
          label={strings.owner}
          members={members}
          ownerMemberId={ownerMemberId}
          ownerInheritanceMode={ownerInheritanceMode}
          inheritedOwnerId={inheritedOwnerId}
          inheritanceSource={inheritanceSource}
          onChange={(choice) => void choose(choice)}
        />
        {error ? (
          <div className="task-row-error" role="alert">
            {error}
          </div>
        ) : null}
        <button
          type="button"
          className="btn"
          onClick={onClose}
          disabled={saving}
        >
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
