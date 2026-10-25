/** Keep only previously visible rows at their old location, using fresh values.
 * This is presentation state, never another domain mutation or query cache. */
export type PlacementId = number | string;
export interface PlacedItem { id: PlacementId; revision?: number; children?: PlacedItem[] }

export function retainPlacement<T extends PlacedItem>(
  previous: Record<string, T[]>, current: Record<string, T[]>, holding: ReadonlySet<PlacementId> | ((item: T) => boolean),
  latest: (item: T) => T,
  inheritValue: (current: T, inherited: T) => T = current => current,
): Record<string, T[]> {
  // Values may have moved elsewhere in the response; location is independent.
  const currentById = new Map<PlacementId, T>();
  const index = (items: T[]) => { for (const item of items) {
    const existing = currentById.get(item.id);
    if (!existing || (item.revision ?? 0) >= (existing.revision ?? 0)) currentById.set(item.id, item);
    index((item.children ?? []) as T[]);
  } };
  Object.values(current).forEach(index);
  // A held subtree owns its displayed descendants as well as its root;
  // otherwise promoted open children would also render in a destination bucket.
  const frozen = new Set<PlacementId>();
  const isHeld = typeof holding === "function" ? holding : (item: T) => holding.has(item.id);
  const collect = (items: T[], heldAncestor = false): boolean => {
    let any = false;
    for (const item of items) {
      const owned = heldAncestor || isHeld(item);
      const childHeld = collect((item.children ?? []) as T[], owned);
      if (owned || childHeld) { frozen.add(item.id); any = true; }
    }
    return any;
  };
  Object.values(previous).forEach(items => collect(items));
  // Each level filters only its own siblings. Child membership comes from
  // the current response; retained parent values may supply descendant-policy
  // outcomes, but cannot replace an authoritative hierarchy.
  const merge = (before: T[], after: T[], inherited: T[] = []): T[] => {
    const beforeById = new Map(before.map(item => [item.id, item]));
    const inheritedById = new Map(inherited.map(item => [item.id, item]));
    const project = (old: T | undefined, item: T | undefined): T => {
      const id = (item ?? old)!.id;
      const raw = currentById.get(id) ?? item;
      const policyValue = inheritedById.get(id);
      const source = policyValue && (!raw || (policyValue.revision ?? 0) > (raw.revision ?? 0))
        ? policyValue : raw ?? old!;
      const value = latest(source);
      const fresh = raw && policyValue ? inheritValue(value, policyValue) : value;
      const descendantValues = policyValue && (policyValue.revision ?? 0) >= (value.revision ?? 0)
        ? policyValue.children : value.children;
      return old?.children || raw?.children || fresh.children
        ? { ...fresh, children: merge((old?.children ?? []) as T[], (raw?.children ?? []) as T[], (descendantValues ?? []) as T[]) }
        : fresh;
    };
    const result = after.filter(item => !frozen.has(item.id))
      .map(item => project(beforeById.get(item.id), item));
    const present = new Set(result.map(item => item.id));
    for (let index = 0; index < before.length; index += 1) {
      const old = before[index]!;
      if (!frozen.has(old.id)) continue;
      const item = project(old, currentById.get(old.id));
      const next = before.slice(index + 1).find(candidate => present.has(candidate.id));
      const prior = before.slice(0, index).reverse().find(candidate => present.has(candidate.id));
      const position = next ? result.findIndex(row => row.id === next.id)
        : prior ? result.findIndex(row => row.id === prior.id) + 1 : Math.min(index, result.length);
      result.splice(position, 0, item);
      present.add(item.id);
    }
    return result;
  };
  return Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .map(key => [key, merge(previous[key] ?? [], current[key] ?? [])]));
}
