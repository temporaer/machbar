import { useLayoutEffect, useRef } from "react";
import { retainPlacement, type PlacedItem, type PlacementId } from "./retainedPlacement";

/** One instance per view, reset by its explicit filter/identity selection. */
export function useRetainedPlacement<T extends PlacedItem, K extends string>(
  buckets: Record<K, T[]>, holding: ReadonlySet<PlacementId> | ((item: T) => boolean), latest: (item: T) => T,
  selectionKey = "",
  inheritValue?: (current: T, inherited: T) => T,
): Record<K, T[]> {
  const layout = useRef<{ key: string; buckets: Record<string, T[]> }>({ key: selectionKey, buckets: {} });
  const previous = layout.current.key === selectionKey ? layout.current.buckets : {};
  const projected = retainPlacement(previous, buckets, holding, latest, inheritValue);
  useLayoutEffect(() => { layout.current = { key: selectionKey, buckets: projected }; });
  return projected as Record<K, T[]>;
}
