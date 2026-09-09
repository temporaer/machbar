import { createContext, useContext, type ReactNode } from "react";
import type { Task } from "@machbar/shared";

export type NextActionBadgeKind = "canonical" | "additional" | "marked";

export interface NextActionBadgeInfo {
  /** The single canonical Next Action's task id for this project, if any. */
  canonicalId: number | null;
  /**
   * Task ids currently selected via the `additionalNextAction` opt-in
   * mechanism (genuinely eligible right now) -- see
   * `Graph.additionalSelectedNextActionsFor`.
   */
  additionalSelectedIds: ReadonlySet<number>;
}

const NextActionBadgeContext = createContext<NextActionBadgeInfo | null>(null);

/**
 * Makes a project's derived Next Action state available to every `TaskRow`
 * in its outline, however deeply nested, without threading the info
 * through every recursive `TaskRow` call (mirrors `OutlineOrganizeProvider`/
 * `useInteractionScope`). Not wrapping the outline (the default for
 * compiled views like Today/Waiting/Search) means no badge renders.
 */
export function NextActionBadgeProvider({
  value,
  children,
}: {
  value: NextActionBadgeInfo;
  children: ReactNode;
}) {
  return (
    <NextActionBadgeContext.Provider value={value}>{children}</NextActionBadgeContext.Provider>
  );
}

/**
 * Distinguishes the *derived current state* (`canonical`/`additional`, both
 * meaning "this task is actually one of Machbar's current GTD Next Actions
 * right now") from the *stored user intent* (`marked`: opted in via
 * `task.additionalNextAction`, but not currently eligible/selected -- e.g.
 * blocked). Returns `null` outside a `NextActionBadgeProvider` or when
 * neither applies.
 */
export function useNextActionBadge(task: Task): NextActionBadgeKind | null {
  const info = useContext(NextActionBadgeContext);
  if (!info) return null;
  if (info.canonicalId === task.id) return "canonical";
  if (info.additionalSelectedIds.has(task.id)) return "additional";
  if (task.additionalNextAction) return "marked";
  return null;
}
