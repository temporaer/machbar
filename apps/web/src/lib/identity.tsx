import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AuthStatus, Member } from "@machbar/shared";
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
  authEnabled: boolean;
  authenticated: boolean;
  authLoading: boolean;
  authError: string | null;
  loginError: string | null;
  reloadAuth: () => void;
  login: () => void;
  logout: () => Promise<void>;
}

function consumeLoginError(): string | null {
  const params = new URLSearchParams(window.location.search);
  const message = params.get("authError");
  if (!message) return null;
  params.delete("authError");
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
  return message;
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
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loginError] = useState<string | null>(() => consumeLoginError());

  const load = useCallback(() => {
    setMembersLoading(true);
    setMembersError(null);
    api
      .getMembers()
      .then(setMembers)
      .catch((err: unknown) => setMembersError(err instanceof Error ? err.message : String(err)))
      .finally(() => setMembersLoading(false));
  }, []);

  const loadAuth = useCallback(() => {
    setAuthLoading(true);
    setAuthError(null);
    const getAuthStatus = api.getAuthStatus;
    if (typeof getAuthStatus !== "function") {
      setAuthStatus({ enabled: false, authenticated: false, member: null });
      setAuthLoading(false);
      load();
      return;
    }
    getAuthStatus()
      .then((status) => {
        setAuthStatus(status);
        if (status.enabled && !status.authenticated) {
          setMembers([]);
          setMembersLoading(false);
        } else {
          load();
        }
      })
      .catch((err: unknown) => {
        setAuthError(err instanceof Error ? err.message : String(err));
        setMembersLoading(false);
      })
      .finally(() => setAuthLoading(false));
  }, [load]);

  useEffect(() => {
    loadAuth();
  }, [loadAuth]);

  useEffect(() => {
    const requireAuthentication = () => {
      setAuthStatus({ enabled: true, authenticated: false, member: null });
      setMembers([]);
      setMembersLoading(false);
    };
    window.addEventListener("machbar:authentication-required", requireAuthentication);
    return () =>
      window.removeEventListener(
        "machbar:authentication-required",
        requireAuthentication,
      );
  }, []);

  const setCurrentMemberId = useCallback((id: number | null) => {
    if (authStatus?.enabled) return;
    setCurrentMemberIdState(id);
    try {
      if (id === null) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, String(id));
    } catch {
      /* localStorage may be unavailable (private mode, tests) */
    }
  }, [authStatus?.enabled]);

  // After a member is deleted (or otherwise disappears, e.g. server reseed),
  // don't let a stale id linger in state/storage once the fresh member list
  // has loaded and no longer contains it — the "Wer bist du?" selector must
  // never keep a phantom selection.
  useEffect(() => {
    if (authStatus?.enabled || membersLoading) return;
    if (currentMemberId !== null && !members.some((m) => m.id === currentMemberId)) {
      setCurrentMemberId(null);
    }
  }, [authStatus?.enabled, membersLoading, members, currentMemberId, setCurrentMemberId]);

  const currentMember = useMemo(() => {
    if (authStatus?.enabled) {
      if (!authStatus.authenticated || !authStatus.member) return null;
      return (
        members.find((member) => member.id === authStatus.member!.id) ??
        authStatus.member
      );
    }
    return members.find((member) => member.id === currentMemberId) ?? null;
  }, [authStatus, members, currentMemberId]);

  const login = useCallback(() => {
    const returnTo = `${window.location.pathname}${window.location.hash || "#/heute"}`;
    window.location.assign(
      `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    );
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setAuthStatus({ enabled: true, authenticated: false, member: null });
    setMembers([]);
    setMembersLoading(false);
  }, []);

  const value = useMemo<IdentityContextValue>(
    () => ({
      members,
      membersLoading,
      membersError,
      reloadMembers: load,
      currentMemberId: currentMember?.id ?? null,
      currentMember,
      setCurrentMemberId,
      authEnabled: authStatus?.enabled ?? false,
      authenticated: authStatus?.authenticated ?? false,
      authLoading,
      authError,
      loginError,
      reloadAuth: loadAuth,
      login,
      logout,
    }),
    [
      members,
      membersLoading,
      membersError,
      load,
      currentMember,
      setCurrentMemberId,
      authStatus,
      authLoading,
      authError,
      loginError,
      loadAuth,
      login,
      logout,
    ],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityContextValue {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error("useIdentity must be used within an IdentityProvider");
  return ctx;
}
