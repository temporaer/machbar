import type { CSSProperties } from "react";
import type { Tag, TagKind } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useLocale, type Locale } from "../lib/locale";

const kindPriority: Record<Exclude<TagKind, "actor">, number> = {
  area: 0,
  context: 1,
  plain: 2,
};

function displayKindPriority(kind: TagKind): number {
  return kind === "actor" ? Number.MAX_SAFE_INTEGER : kindPriority[kind];
}

function compareDisplayTags(a: Tag, b: Tag, locale: Locale): number {
  const kindDifference =
    displayKindPriority(a.kind) - displayKindPriority(b.kind);
  if (kindDifference !== 0) return kindDifference;

  const groupingDifference =
    Number(b.groupingMode === "pinned") - Number(a.groupingMode === "pinned");
  if (groupingDifference !== 0) return groupingDifference;

  const positionDifference =
    (a.sortPosition ?? Number.MAX_SAFE_INTEGER) -
    (b.sortPosition ?? Number.MAX_SAFE_INTEGER);
  if (positionDifference !== 0) return positionDifference;

  const nameDifference = a.name.localeCompare(b.name, locale, {
    sensitivity: "base",
  });
  return nameDifference || a.id - b.id;
}

export function taskCardDisplayTags(
  tags: Tag[],
  locale: Locale = "de",
): Tag[] {
  return tags
    .filter((tag) => tag.kind !== "actor")
    .sort((a, b) => compareDisplayTags(a, b, locale));
}

export function TaskCardTags({ tags }: { tags: Tag[] }) {
  const strings = useStrings();
  const { locale } = useLocale();
  const displayTags = taskCardDisplayTags(tags, locale);
  if (displayTags.length === 0) return null;

  const visibleTags = displayTags.slice(0, 2);
  const overflow = displayTags.length - visibleTags.length;

  return (
    <span className="task-card-tags" role="list" aria-label={strings.taskTags}>
      {visibleTags.map((tag) => (
        <span
          className="task-card-tag"
          key={tag.id}
          role="listitem"
          title={tag.name}
          style={{ "--tag-color": tag.color } as CSSProperties}
        >
          {tag.name}
        </span>
      ))}
      {overflow > 0 ? (
        <span
          className="task-card-tag-overflow"
          role="listitem"
          aria-label={strings.moreTaskTags(overflow)}
          title={strings.moreTaskTags(overflow)}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}
