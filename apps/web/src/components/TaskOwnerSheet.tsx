import { useMemo, useState } from "react";
import type { InheritanceMode, Member } from "@machbar/shared";
import {
  extractCaptionHints,
  removeCaptionHintSpans,
  strongestCaptionHints,
  type MemberCaptionHint,
} from "../lib/captionHints";
import { localizedErrorMessage } from "../lib/errorMessage";
import { useLocale } from "../lib/locale";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { CaptionHintSuggestions } from "./CaptionHintSuggestions";
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
  createdAt,
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
  createdAt?: string;
  members: Member[];
  ownerMemberId: number | null;
  ownerInheritanceMode: InheritanceMode;
  inheritedOwnerId: number | null;
  inheritanceSource: "parent" | "project" | null;
  onClose: () => void;
  onSelect: (choice: TaskOwnerChoice, cleanedTitle?: string) => Promise<void>;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hints = useMemo(
    () =>
      strongestCaptionHints(
        extractCaptionHints(taskTitle, {
          locale,
          referenceDate: createdAt ? new Date(createdAt) : new Date(0),
          members,
        }).filter((hint): hint is MemberCaptionHint => hint.kind === "member"),
      ),
    [createdAt, locale, members, taskTitle],
  );

  const choose = async (choice: TaskOwnerChoice, hint?: MemberCaptionHint) => {
    if (saving) return;
    if (!hint && sameChoice(ownerMemberId, ownerInheritanceMode, choice)) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSelect(
        choice,
        hint
          ? removeCaptionHintSpans(taskTitle, [hint.removalSpan])
          : undefined,
      );
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
        <CaptionHintSuggestions
          hints={hints.map((hint) => ({ key: hint.key, label: hint.member.name }))}
          disabled={saving}
          onSelect={(key) => {
            const hint = hints.find((candidate) => candidate.key === key);
            if (hint) {
              void choose(
                {
                  ownerMemberId: hint.member.id,
                  ownerInheritanceMode: "explicit",
                },
                hint,
              );
            }
          }}
        />
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
