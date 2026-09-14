import type { InheritanceMode, PhysicalContext } from "@machbar/shared";

export function updatePhysicalContextSelection(
  contextId: number,
  selected: readonly PhysicalContext[],
  inherited: readonly PhysicalContext[],
  mode: InheritanceMode | undefined,
  shouldSelect: boolean,
): { mode: InheritanceMode | undefined; contextIds: number[] } {
  const isInheriting = mode === "inherit" && inherited.length > 0;
  const next = new Set(
    (isInheriting ? inherited : selected).map((context) => context.id),
  );
  if (shouldSelect) next.add(contextId);
  else next.delete(contextId);
  return {
    mode: mode === undefined ? undefined : "explicit",
    contextIds: [...next],
  };
}
