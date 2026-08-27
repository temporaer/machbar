import { useState } from "react";
import type { Member } from "@machbar/shared";
import { MemberAvatar } from "./MemberAvatar";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { strings } from "../lib/strings";
import { LoadingState, ErrorState, EmptyState } from "./AsyncStates";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Household-member editor under Mehr. The real backend
 * (`apps/api/src/routes/members.ts`) is expected to grow
 * `POST/PATCH/DELETE /api/members` alongside the existing `GET`; this only
 * calls those REST endpoints and always reloads the shared member list
 * through `useIdentity().reloadMembers` afterwards, so the "Wer bist du?"
 * selector (`IdentitySelector`) never shows stale data and never keeps a
 * deleted member selected (see `identity.tsx`'s stale-id cleanup effect).
 */
export function MemberManager() {
  const { members, membersLoading, membersError, reloadMembers } = useIdentity();
  const { bump } = useRefresh();

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  const setRowError = (id: number, message: string) =>
    setRowErrors((prev) => ({ ...prev, [id]: message }));
  const clearRowError = (id: number) =>
    setRowErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const submitCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    setCreateError(null);
    try {
      await api.createMember({ name: trimmed });
      setNewName("");
      reloadMembers();
      bump();
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (member: Member) => {
    setEditingId(member.id);
    setEditName(member.name);
    clearRowError(member.id);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
  };

  const submitRename = async (member: Member) => {
    const trimmed = editName.trim();
    if (!trimmed) return;
    setSavingId(member.id);
    clearRowError(member.id);
    try {
      await api.updateMember(member.id, { name: trimmed });
      setEditingId(null);
      reloadMembers();
      bump();
    } catch (err) {
      setRowError(member.id, errorMessage(err));
    } finally {
      setSavingId(null);
    }
  };

  const remove = async (member: Member) => {
    if (!window.confirm(strings.memberDeleteConfirm)) return;
    setDeletingId(member.id);
    clearRowError(member.id);
    try {
      await api.deleteMember(member.id);
      reloadMembers();
      bump();
    } catch (err) {
      setRowError(member.id, errorMessage(err));
    } finally {
      setDeletingId(null);
    }
  };

  if (membersLoading) return <LoadingState />;
  if (membersError) return <ErrorState message={membersError} onRetry={reloadMembers} />;

  return (
    <div className="stack">
      {members.length === 0 ? (
        <EmptyState message={strings.noMembers} />
      ) : (
        <ul className="list" style={{ padding: 0, margin: 0 }}>
          {members.map((member) => (
            <li key={member.id} className="row-between" style={{ padding: "6px 0" }}>
              {editingId === member.id ? (
                <form
                  className="row"
                  style={{ flex: 1 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitRename(member);
                  }}
                >
                  <input
                    aria-label={strings.editMemberName}
                    value={editName}
                    autoFocus
                    onChange={(e) => setEditName(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn btn-sm btn-primary"
                    disabled={savingId === member.id || !editName.trim()}
                  >
                    {strings.save}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={cancelEdit}>
                    {strings.cancel}
                  </button>
                </form>
              ) : (
                <>
                  <span className="row">
                    <MemberAvatar member={member} size="sm" />
                    <span>{member.name}</span>
                    {member.managedByOidc ? (
                      <span className="badge">{strings.pocketIdManaged}</span>
                    ) : null}
                  </span>
                  {!member.managedByOidc ? (
                    <span className="row">
                      <button type="button" className="btn btn-sm" onClick={() => startEdit(member)}>
                        {strings.renameMember}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={deletingId === member.id}
                        onClick={() => void remove(member)}
                      >
                        {strings.delete}
                      </button>
                    </span>
                  ) : null}
                </>
              )}
              {rowErrors[member.id] ? (
                <p className="text-muted" role="alert" style={{ width: "100%", margin: "4px 0 0" }}>
                  {rowErrors[member.id]}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void submitCreate();
        }}
      >
        <input
          aria-label={strings.memberName}
          placeholder={strings.memberNamePlaceholder}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={creating || !newName.trim()}>
          {strings.addMember}
        </button>
      </form>
      {createError ? (
        <p className="text-muted" role="alert">
          {createError}
        </p>
      ) : null}
    </div>
  );
}
