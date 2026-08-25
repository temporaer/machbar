import type { Member } from "@machbar/shared";
import { useIdentity } from "../lib/identity";
import { strings } from "../lib/strings";
import { fallbackColor, initials } from "../lib/format";
import { LoadingState, ErrorState } from "./AsyncStates";

/**
 * A pure selection list for "Wer bist du?". The real backend now also
 * exposes `POST/PATCH/DELETE /api/members` for household-member management
 * (see `MemberManager`, mounted under Mehr) — this component stays
 * selection-only and always reflects the freshly reloaded member list, so it
 * can never show a member that was just renamed or deleted elsewhere.
 */
export function IdentitySelector({ onSelected }: { onSelected?: (member: Member) => void }) {
  const { members, membersLoading, membersError, reloadMembers, currentMemberId, setCurrentMemberId } =
    useIdentity();

  if (membersLoading) return <LoadingState />;
  if (membersError) return <ErrorState message={membersError} onRetry={reloadMembers} />;

  return (
    <div className="stack">
      <div className="identity-grid" role="listbox" aria-label={strings.identity}>
        {members.map((member) => (
          <button
            key={member.id}
            type="button"
            role="option"
            aria-selected={member.id === currentMemberId}
            className={`identity-card${member.id === currentMemberId ? " selected" : ""}`}
            onClick={() => {
              setCurrentMemberId(member.id);
              onSelected?.(member);
            }}
          >
            <span className="avatar" style={{ background: member.color || fallbackColor(member.id) }}>
              {initials(member.name)}
            </span>
            <span>{member.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
