/** Keep only previously visible rows at their old location, using fresh values.
 * This is presentation state, never another domain mutation or query cache. */
export interface PlacedItem { id: number; revision?: number; children?: PlacedItem[] }

export function retainPlacement<T extends PlacedItem>(
  previous: Record<string, T[]>, current: Record<string, T[]>, holding: ReadonlySet<number>,
  latest: (item: T) => T,
): Record<string, T[]> {
  // Values may have moved elsewhere in the response; location is independent.
  const currentById = new Map<number, T>();
  const index = (items: T[]) => { for (const item of items) {
    const existing = currentById.get(item.id);
    if (!existing || (item.revision ?? 0) >= (existing.revision ?? 0)) currentById.set(item.id, item);
    index((item.children ?? []) as T[]);
  } };
  Object.values(current).forEach(index);
  // A held subtree owns its displayed descendants as well as its root;
  // otherwise promoted open children would also render in a destination bucket.
  const frozen = new Set<number>();
  const collect = (items: PlacedItem[], heldAncestor = false): boolean => {
    let any = false;
    for (const item of items) {
      const owned = heldAncestor || holding.has(item.id);
      const childHeld = collect(item.children ?? [], owned);
      if (owned || childHeld) { frozen.add(item.id); any = true; }
    }
    return any;
  };
  Object.values(previous).forEach(items => collect(items));
  const strip = (items: T[]): T[] => items.filter(item => !frozen.has(item.id)).map(item =>
    item.children ? { ...item, children: strip(item.children as T[]) } : item);
  const merge = (before: T[], after: T[]): T[] => {
    const result = strip(after).map(item => {
      const old = before.find(candidate => candidate.id === item.id);
      return item.children ? { ...latest(item), children: merge((old?.children ?? []) as T[], item.children as T[]) } : latest(item);
    });
    for (let index = 0; index < before.length; index += 1) {
      const old = before[index]!;
      if (!frozen.has(old.id)) continue;
      const elsewhere = currentById.get(old.id);
      const local = after.find(item => item.id === old.id);
      const source = elsewhere && (!local || (elsewhere.revision ?? 0) > (local.revision ?? 0)) ? elsewhere : local;
      const fresh = latest(source ?? old);
      // An absent ancestor exists only to carry retained paths. Unheld
      // siblings belong to the fresh response, not this reconstructed path.
      const children = (fresh.children ?? []) as T[];
      const visibleChildren = elsewhere ? children : children.filter(child => frozen.has(child.id));
      const item = old.children ? { ...fresh, children: merge(old.children as T[], visibleChildren) } : fresh;
      const next = before.slice(index + 1).find(candidate => result.some(row => row.id === candidate.id));
      const prior = before.slice(0, index).reverse().find(candidate => result.some(row => row.id === candidate.id));
      const position = next ? result.findIndex(row => row.id === next.id)
        : prior ? result.findIndex(row => row.id === prior.id) + 1 : Math.min(index, result.length);
      result.splice(position, 0, item);
    }
    return result;
  };
  return Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .map(key => [key, merge(previous[key] ?? [], current[key] ?? [])]));
}
