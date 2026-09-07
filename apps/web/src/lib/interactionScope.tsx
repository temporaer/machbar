import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Where a contextual capture (QuickAdd) should file a new item captured
 * while this scope is active. `story` targets are used by a project/story
 * outline; every other navigable surface (Today, Inbox, Waiting, Review,
 * All) captures to the inbox. Consumed directly by `QuickAdd.tsx`, which
 * reads this instead of taking a page-supplied `projectId` prop.
 */
export type CaptureTarget = { kind: "inbox" } | { kind: "story"; storyId: number };
export type WorkItemInteractionRole = "task" | "story";

/** Matches `OrganizeDirection` in `useOutlineOrganize.tsx`; not imported
 * from there to avoid a circular import (that module imports this one). */
export type StructuralMoveDirection = "up" | "down" | "indent" | "outdent";

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
  activeRole: WorkItemInteractionRole | null;
  setActive: (id: number | null, role?: WorkItemInteractionRole | null) => void;
  /** The one row whose left-swipe command rail is currently open. */
  openRailId: number | null;
  setOpenRail: (id: number | null) => void;
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
  /**
   * The specific mounted `useOutlineOrganize()` instance's own `moveBy`,
   * registered by that instance alongside its capability flags -- never a
   * second, independently-implemented mover. `null` whenever no
   * `organizable` outline is currently mounted in this scope (compiled
   * views, or an outline before it declares itself). Used by
   * `Alt+↑/↓/←/→` structural keyboard commands.
   */
  moveBy: ((workItemId: number, direction: StructuralMoveDirection) => void) | null;
  setStructuralCapability: (capability: {
    canReorder: boolean;
    canReparent: boolean;
    moveBy?: ((workItemId: number, direction: StructuralMoveDirection) => void) | null;
  }) => void;
  captureTarget: CaptureTarget;
  captureOpen: (() => void) | null;
  setCaptureOpen: (handler: (() => void) | null) => void;
  helpOpen: (() => void) | null;
  setHelpOpen: (handler: (() => void) | null) => void;
  /**
   * Fold state keyed by WorkItem id, replacing the private `collapsed`
   * `useState` that used to live inside each `TaskRow` -- folding is a
   * structural interaction capability (`h`/`l`) that must be readable and
   * settable from outside the row that happens to render a given item.
   * Not persisted; resets like the old per-row state did.
   */
  isCollapsed: (workItemId: number) => boolean;
  setCollapsed: (workItemId: number, value: boolean) => void;
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
  const [activeRole, setActiveRole] = useState<WorkItemInteractionRole | null>(null);
  const [openRailId, setOpenRail] = useState<number | null>(null);
  useEffect(() => {
    const closeRailOutsideRows = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest("[data-workitem-id]")) setOpenRail(null);
    };
    document.addEventListener("pointerdown", closeRailOutsideRows);
    return () => document.removeEventListener("pointerdown", closeRailOutsideRows);
  }, []);
  const setActiveItem = useCallback((id: number | null, role: WorkItemInteractionRole | null = null) => {
    setActive(id);
    setActiveRole(id === null ? null : role);
  }, []);
  const [capability, setCapability] = useState<{
    canReorder: boolean;
    canReparent: boolean;
    moveBy: ((workItemId: number, direction: StructuralMoveDirection) => void) | null;
  }>({ canReorder: false, canReparent: false, moveBy: null });
  const setStructuralCapability = useCallback(
    (next: {
      canReorder: boolean;
      canReparent: boolean;
      moveBy?: ((workItemId: number, direction: StructuralMoveDirection) => void) | null;
    }) => {
      const nextMoveBy = next.moveBy ?? null;
      setCapability((prev) =>
        prev.canReorder === next.canReorder && prev.canReparent === next.canReparent && prev.moveBy === nextMoveBy
          ? prev
          : { canReorder: next.canReorder, canReparent: next.canReparent, moveBy: nextMoveBy },
      );
    },
    [],
  );
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<number>>(() => new Set());
  const [captureOpen, setCaptureOpen] = useState<(() => void) | null>(null);
  const [helpOpen, setHelpOpen] = useState<(() => void) | null>(null);
  const isCollapsed = useCallback((workItemId: number) => collapsedIds.has(workItemId), [collapsedIds]);
  const setCollapsed = useCallback((workItemId: number, value: boolean) => {
    setCollapsedIds((prev) => {
      const already = prev.has(workItemId);
      if (already === value) return prev;
      const next = new Set(prev);
      if (value) next.add(workItemId);
      else next.delete(workItemId);
      return next;
    });
  }, []);
  const value = useMemo<InteractionScopeValue>(
    () => ({
      activeId,
      activeRole,
      setActive: setActiveItem,
      openRailId,
      setOpenRail,
      canReorder: capability.canReorder,
      canReparent: capability.canReparent,
      moveBy: capability.moveBy,
      setStructuralCapability,
      captureTarget,
      captureOpen,
      setCaptureOpen,
      helpOpen,
      setHelpOpen,
      isCollapsed,
      setCollapsed,
    }),
    [
      activeId,
      activeRole,
      setActiveItem,
      openRailId,
      capability,
      setStructuralCapability,
      captureTarget,
      captureOpen,
      helpOpen,
      isCollapsed,
      setCollapsed,
    ],
  );
  return <InteractionScopeContext.Provider value={value}>{children}</InteractionScopeContext.Provider>;
}

/** Every navigable page must mount its own `InteractionScopeProvider`; this throws otherwise. */
export function useInteractionScope(): InteractionScopeValue {
  const ctx = useContext(InteractionScopeContext);
  if (!ctx) throw new Error("useInteractionScope must be used within an InteractionScopeProvider");
  return ctx;
}

/**
 * Same as `useInteractionScope`, but returns `null` instead of throwing
 * outside a provider. Used by call sites that are shared with contexts
 * that don't (yet) mount a scope, such as `useWorkItemCommands()`'s
 * generic "update the active item" side effect -- not every future
 * `dispatch()` caller is guaranteed to sit inside a navigable page scope.
 */
export function useOptionalInteractionScope(): InteractionScopeValue | null {
  return useContext(InteractionScopeContext);
}
