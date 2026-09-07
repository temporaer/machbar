import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Where a contextual capture (QuickAdd) should file a new item captured
 * while this scope is active. `story` targets are used by a project/story
 * outline; every other navigable surface (Today, Inbox, Waiting, Review,
 * All) captures to the inbox. Not yet consumed -- QuickAdd still takes its
 * target as a page-supplied prop (see `QuickAdd.tsx`). Wiring QuickAdd to
 * read this instead is Phase 9 (contextual capture consolidation); the
 * field is declared here now so the scope's shape does not need to change
 * again once that happens.
 */
export type CaptureTarget = { kind: "inbox" } | { kind: "story"; storyId: number };

export interface InteractionScopeValue {
  /**
   * The one logical WorkItem the user is conceptually "on" in this scope,
   * independent of transient DOM focus. Replaces the "selected task"
   * state that used to live privately inside each `useOutlineOrganize`
   * instance (see that module) -- one scope can contain several outline
   * mounts (e.g. Today's per-section `TaskOutline`s), and they now share
   * one active item instead of each keeping its own.
   */
  activeId: number | null;
  setActive: (id: number | null) => void;
  /**
   * True only where every `TaskOutline` mounted in this scope right now
   * renders a complete stored sibling group (a project/story's own task
   * tree), never a compiled subset (Today/Inbox/Waiting/Search/All). This
   * is *declared by the mounted outline itself* via
   * `setStructuralCapability`, not by the page up front, so there is only
   * one source of truth and no separate flag that could drift out of
   * sync with the outline's own `organizable` prop.
   */
  canReorder: boolean;
  canReparent: boolean;
  setStructuralCapability: (capability: { canReorder: boolean; canReparent: boolean }) => void;
  captureTarget: CaptureTarget;
}

const InteractionScopeContext = createContext<InteractionScopeValue | null>(null);

export interface InteractionScopeProviderProps {
  children: ReactNode;
  captureTarget?: CaptureTarget;
}

/**
 * One scope per navigable surface -- Today, Inbox, All, Waiting, Review, a
 * project/story outline. Mounted once per page component (see each page's
 * top-level render). Do not mount a single global instance: the whole
 * point is that a compiled page and an outline page answer `canReorder`
 * differently, and a project/story outline's captured items file into
 * that story by default while everywhere else files into the inbox.
 */
export function InteractionScopeProvider({ children, captureTarget = { kind: "inbox" } }: InteractionScopeProviderProps) {
  const [activeId, setActive] = useState<number | null>(null);
  const [capability, setCapability] = useState({ canReorder: false, canReparent: false });
  const setStructuralCapability = useCallback((next: { canReorder: boolean; canReparent: boolean }) => {
    setCapability((prev) =>
      prev.canReorder === next.canReorder && prev.canReparent === next.canReparent ? prev : next,
    );
  }, []);
  const value = useMemo<InteractionScopeValue>(
    () => ({
      activeId,
      setActive,
      canReorder: capability.canReorder,
      canReparent: capability.canReparent,
      setStructuralCapability,
      captureTarget,
    }),
    [activeId, capability, setStructuralCapability, captureTarget],
  );
  return <InteractionScopeContext.Provider value={value}>{children}</InteractionScopeContext.Provider>;
}

/** Every navigable page must mount its own `InteractionScopeProvider`; this throws otherwise. */
export function useInteractionScope(): InteractionScopeValue {
  const ctx = useContext(InteractionScopeContext);
  if (!ctx) throw new Error("useInteractionScope must be used within an InteractionScopeProvider");
  return ctx;
}
