import { useState, type FormEvent } from "react";
import type { Member } from "@machbar/shared";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { strings } from "../lib/strings";
import { LoadingState, ErrorState } from "./AsyncStates";
import { MemberAvatar } from "./MemberAvatar";

/**
 * Identity selection normally only chooses an existing member. On a fresh,
 * empty installation it also provides the one bootstrap operation needed to
 * reach the rest of the app: creating and immediately selecting the first
 * member.
 */
export function IdentitySelector({ onSelected }: { onSelected?: (member: Member) => void }) {
  const { members, membersLoading, membersError, reloadMembers, currentMemberId, setCurrentMemberId } =
    useIdentity();
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const createFirstMember = async (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const member = await api.createMember({ name });
      setCurrentMemberId(member.id);
      reloadMembers();
      onSelected?.(member);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : strings.error);
    } finally {
      setCreating(false);
    }
  };

  if (membersLoading) return <LoadingState />;
  if (membersError) return <ErrorState message={membersError} onRetry={reloadMembers} />;

  return (
    <div className="stack">
      {members.length === 0 ? (
        <>
          <p className="text-muted">{strings.firstMemberHint}</p>
          <form className="row" onSubmit={(event) => void createFirstMember(event)}>
            <input
              autoFocus
              aria-label={strings.memberName}
              placeholder={strings.memberNamePlaceholder}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={creating || !newName.trim()}
            >
              {strings.addMember}
            </button>
          </form>
          {createError ? <p className="text-muted" role="alert">{createError}</p> : null}
        </>
      ) : (
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
              <MemberAvatar member={member} size="lg" />
              <span>{member.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
