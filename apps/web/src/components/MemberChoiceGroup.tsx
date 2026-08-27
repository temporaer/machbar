import type { Member } from "@machbar/shared";

/**
 * Tap-target picker for "who is responsible?" used by every *focused*
 * assignment popup (task owner, story driver, refinement assignment).
 *
 * A household tops out at ~5 members, so the whole choice set fits on screen
 * as chips. That beats a `<select>` on mobile: no native picker overlay on
 * top of the bottom sheet, one tap instead of open-scroll-confirm, and the
 * current assignment stays visible while choosing. It is equally useful in
 * full editors, where changing the owner is still one clear decision.
 *
 * Accessibility: the chips form a labelled `role="group"` and each chip
 * reports its selection through `aria-pressed`, so the state is announced
 * without relying on colour alone.
 */
export function MemberChoiceGroup({
  label,
  idPrefix,
  members,
  value,
  onChange,
  unassignedLabel = null,
  disabled = false,
  autoFocus = false,
}: {
  /** Visible + accessible name of the group, e.g. "Zuständig". */
  label: string;
  /** Unique per mounted instance — rows can stack several sheets' markup. */
  idPrefix: string;
  members: Member[];
  value: number | null;
  onChange: (memberId: number | null) => void;
  /**
   * Label for the "nobody" chip (`Gemeinsam / offen`, `Niemand zugewiesen`).
   * Pass `null` where clearing is not a legal choice — e.g. assigning a
   * driver in order to activate a story.
   */
  unassignedLabel?: string | null;
  disabled?: boolean;
  /** Focuses the currently selected chip when the sheet opens. */
  autoFocus?: boolean;
}) {
  const labelId = `${idPrefix}-label`;
  const focusTarget = value === null && unassignedLabel === null ? members[0]?.id ?? null : value;

  return (
    <div className="field">
      <span className="field-label" id={labelId}>
        {label}
      </span>
      <div className="choice-group" role="group" aria-labelledby={labelId}>
        {unassignedLabel !== null ? (
          <button
            type="button"
            className="choice-chip"
            aria-pressed={value === null}
            disabled={disabled}
            autoFocus={autoFocus && focusTarget === null}
            onClick={() => onChange(null)}
          >
            {unassignedLabel}
          </button>
        ) : null}
        {members.map((member) => (
          <button
            key={member.id}
            type="button"
            className="choice-chip"
            aria-pressed={value === member.id}
            disabled={disabled}
            autoFocus={autoFocus && focusTarget === member.id}
            onClick={() => onChange(member.id)}
          >
            {member.name}
          </button>
        ))}
      </div>
    </div>
  );
}
