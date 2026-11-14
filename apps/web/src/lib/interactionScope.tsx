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

type StructuralCapability = {
  owns: (workItemId: number) => boolean;
  moveBy: (workItemId: number, direction: StructuralMoveDirection) => void;
};

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
  openLifecycleId: number | null;
  setOpenLifecycle: (id: number | null) => void;
  /**
   * True while an outline that renders a complete stored sibling group
   * has registered its structural capability in this scope.
   */
  canReorder: boolean;
  canReparent: boolean;
  /**
   * Dispatches to the mounted outline that owns the item, or is null when
   * no organizable outline is registered.
   */
  moveBy: ((workItemId: number, direction: StructuralMoveDirection) => void) | null;
  registerStructuralCapability: (capability: StructuralCapability) => () => void;
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
  const [openRailId, setOpenRailState] = useState<number | null>(null);
  const [openLifecycleId, setOpenLifecycleState] = useState<number | null>(null);
  const setOpenRail = useCallback((id: number | null) => {
    setOpenRailState(id);
    if (id !== null) setOpenLifecycleState(null);
  }, []);
  const setOpenLifecycle = useCallback((id: number | null) => {
    setOpenLifecycleState(id);
    if (id !== null) setOpenRailState(null);
  }, []);
  useEffect(() => {
    const closeRailOutsideRows = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest("[data-workitem-id]")) {
        setOpenRail(null);
        setOpenLifecycle(null);
      }
    };
    document.addEventListener("pointerdown", closeRailOutsideRows);
    return () => document.removeEventListener("pointerdown", closeRailOutsideRows);
  }, []);
  const setActiveItem = useCallback((id: number | null, role: WorkItemInteractionRole | null = null) => {
    setActive(id);
    setActiveRole(id === null ? null : role);
  }, []);
  const [capabilities, setCapabilities] = useState<StructuralCapability[]>([]);
  const registerStructuralCapability = useCallback((capability: StructuralCapability) => {
    let active = true;
    const registration: StructuralCapability = {
      owns: (id) => active && capability.owns(id),
      moveBy: (id, direction) => { if (active) capability.moveBy(id, direction); },
    };
    setCapabilities((previous) => [...previous, registration]);
    return () => {
      active = false;
      setCapabilities((previous) => previous.filter((entry) => entry !== registration));
    };
  }, []);
  const moveBy = useMemo(() => capabilities.length === 0 ? null :
    (id: number, direction: StructuralMoveDirection) => {
      capabilities.find((capability) => capability.owns(id))?.moveBy(id, direction);
    }, [capabilities]);
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
      openLifecycleId,
      setOpenLifecycle,
      canReorder: capabilities.length > 0,
      canReparent: capabilities.length > 0,
      moveBy,
      registerStructuralCapability,
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
      openLifecycleId,
      setOpenRail,
      capabilities,
      moveBy,
      registerStructuralCapability,
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
