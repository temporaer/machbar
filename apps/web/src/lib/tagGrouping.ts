import type { Tag, TagKind } from "@machbar/shared";
import type { Locale } from "../i18n/catalog";

export const groupableTagKinds = ["actor", "area"] as const;
export type GroupableTagKind = (typeof groupableTagKinds)[number];

export interface TagGroup<T> {
  tag: Tag | null;
  items: T[];
}

function compareTags(a: Tag, b: Tag, locale: Locale): number {
  const pinned =
    Number(b.groupingMode === "pinned") -
    Number(a.groupingMode === "pinned");
  if (pinned !== 0) return pinned;
  const position =
    (a.sortPosition ?? Number.MAX_SAFE_INTEGER) -
    (b.sortPosition ?? Number.MAX_SAFE_INTEGER);
  if (position !== 0) return position;
  const name = a.name.localeCompare(b.name, locale);
  return name !== 0 ? name : a.id - b.id;
}

function primaryTag(tags: Tag[], kind: TagKind, locale: Locale): Tag | null {
  return (
    tags
      .filter((tag) => tag.kind === kind)
      .sort((a, b) => compareTags(a, b, locale))[0] ?? null
  );
}

export function groupItemsByTagKind<T extends { effectiveTags: Tag[] }>(
  items: T[],
  kind: GroupableTagKind,
  locale: Locale = "de",
): TagGroup<T>[] {
  const groups = new Map<number | null, TagGroup<T>>();
  for (const item of items) {
    const tag = primaryTag(item.effectiveTags, kind, locale);
    const key = tag?.id ?? null;
    const group = groups.get(key) ?? { tag, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.tag === null) return b.tag === null ? 0 : 1;
    if (b.tag === null) return -1;
    return compareTags(a.tag, b.tag, locale);
  });
}
