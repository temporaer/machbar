import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Member } from "@machbar/shared";
import { api } from "./api";

const STORAGE_KEY = "machbar:identity-member-id";

interface IdentityContextValue {
  members: Member[];
  membersLoading: boolean;
  membersError: string | null;
  reloadMembers: () => void;
  currentMemberId: number | null;
  currentMember: Member | null;
  setCurrentMemberId: (id: number | null) => void;
}

const IdentityContext = createContext<IdentityContextValue | null>(null);

function readStoredMemberId(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [currentMemberId, setCurrentMemberIdState] = useState<number | null>(() => readStoredMemberId());

  const load = useCallback(() => {
    setMembersLoading(true);
    setMembersError(null);
    api
      .getMembers()
      .then(setMembers)
      .catch((err: unknown) => setMembersError(err instanceof Error ? err.message : String(err)))
      .finally(() => setMembersLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setCurrentMemberId = useCallback((id: number | null) => {
    setCurrentMemberIdState(id);
    try {
      if (id === null) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, String(id));
    } catch {
      /* localStorage may be unavailable (private mode, tests) */
    }
  }, []);

  // After a member is deleted (or otherwise disappears, e.g. server reseed),
  // don't let a stale id linger in state/storage once the fresh member list
  // has loaded and no longer contains it — the "Wer bist du?" selector must
  // never keep a phantom selection.
  useEffect(() => {
    if (membersLoading) return;
    if (currentMemberId !== null && !members.some((m) => m.id === currentMemberId)) {
      setCurrentMemberId(null);
    }
  }, [membersLoading, members, currentMemberId, setCurrentMemberId]);

  const currentMember = useMemo(
    () => members.find((m) => m.id === currentMemberId) ?? null,
    [members, currentMemberId],
  );

  const value = useMemo<IdentityContextValue>(
    () => ({
      members,
      membersLoading,
      membersError,
      reloadMembers: load,
      currentMemberId: currentMember ? currentMemberId : null,
      currentMember,
      setCurrentMemberId,
    }),
    [members, membersLoading, membersError, load, currentMemberId, currentMember, setCurrentMemberId],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityContextValue {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error("useIdentity must be used within an IdentityProvider");
  return ctx;
}
