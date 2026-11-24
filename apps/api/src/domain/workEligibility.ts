import type { ProjectStatus } from "@machbar/shared";

export function effectiveProjectStatuses(
  items: ReadonlyArray<{ id: number; parentId: number | null; role: string }>,
  projectStatuses: ReadonlyMap<number, ProjectStatus>,
): Map<number, ProjectStatus> {
  const parents = new Map(items.map((item) => [item.id, item.parentId]));
  const result = new Map(projectStatuses);
  for (const [id, status] of projectStatuses) {
    if (status !== "active") continue;
    const seen = new Set([id]);
    let parentId = parents.get(id) ?? null;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      if (projectStatuses.get(parentId) === "backlog") {
        result.set(id, "backlog");
        break;
      }
      parentId = parents.get(parentId) ?? null;
    }
  }
  return result;
}

/** Separate persisted lifecycle from viewer-safe working eligibility and hypothetical activation. */
export function projectAvailability(
  items: ReadonlyArray<{ id: number; parentId: number | null; role: string }>,
  lifecycleStatuses: ReadonlyMap<number, ProjectStatus>,
  visibleItemIds: ReadonlySet<number>,
) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const hasHiddenProjectAncestor = (parentId: number | null): boolean => {
    const seen = new Set<number>();
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = itemsById.get(parentId);
      if (!parent) break;
      if (parent.role === "story" && !visibleItemIds.has(parentId)) return true;
      parentId = parent.parentId;
    }
    return false;
  };
  const conservativeGates = new Set<number>();
  for (const [id, status] of lifecycleStatuses) {
    if (!visibleItemIds.has(id) ||
      (status === "active" && hasHiddenProjectAncestor(itemsById.get(id)?.parentId ?? null))) {
      conservativeGates.add(id);
    }
  }
  const workingStatuses = effectiveProjectStatuses(items, lifecycleStatuses);
  for (const id of conservativeGates) workingStatuses.set(id, "backlog");

  const forActivation = (projectId: number): Map<number, ProjectStatus> => {
    const chain = new Set<number>();
    const toActivate: number[] = [];
    let currentId: number | null = projectId;
    while (currentId !== null && !chain.has(currentId)) {
      chain.add(currentId);
      const status = lifecycleStatuses.get(currentId);
      if ((currentId === projectId && status !== "active") || status === "backlog" ||
        (status === "active" && !visibleItemIds.has(currentId))) {
        toActivate.push(currentId);
      }
      currentId = itemsById.get(currentId)?.parentId ?? null;
    }
    if (toActivate.length === 0) return workingStatuses;
    const simulated = new Map(lifecycleStatuses);
    for (const id of toActivate) simulated.set(id, "active");
    const result = effectiveProjectStatuses(items, simulated);
    for (const id of conservativeGates) {
      if (!chain.has(id)) result.set(id, "backlog");
    }
    return result;
  };

  return { workingStatuses, hasHiddenProjectAncestor, forActivation };
}

export function isTaskInWorkingSystem(
  task: { projectId: number | null },
  projectStatusById: ReadonlyMap<number, ProjectStatus>,
): boolean {
  return (
    task.projectId === null ||
    projectStatusById.get(task.projectId) === "active"
  );
}
