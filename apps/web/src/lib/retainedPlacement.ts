/** Keep only previously visible rows at their old location, using fresh values.
 * This is presentation state, never another domain mutation or query cache. */
export interface PlacedItem { id: number; children?: PlacedItem[] }

export function retainPlacement<T extends PlacedItem>(
  previous: Record<string, T[]>, current: Record<string, T[]>, holding: ReadonlySet<number>,
  latest: (item: T) => T,
): Record<string, T[]> {
  const frozen = new Set<number>();
  const collect = (items: PlacedItem[]): boolean => {
    let any = false;
    for (const item of items) {
      const childHeld = collect(item.children ?? []);
      if (holding.has(item.id) || childHeld) { frozen.add(item.id); any = true; }
    }
    return any;
  };
  Object.values(previous).forEach(collect);
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
      const fresh = latest(after.find(item => item.id === old.id) ?? old);
      const item = old.children ? { ...fresh, children: merge(old.children as T[], (fresh.children ?? []) as T[]) } : fresh;
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
