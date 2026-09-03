import type { CSSProperties } from "react";
import type { PhysicalContext, Tag, TagKind } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useLocale, type Locale } from "../lib/locale";

const kindPriority: Record<Exclude<TagKind, "actor">, number> = {
  area: 0,
  plain: 1,
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

export function TaskCardTags({
  tags,
  contexts = [],
}: {
  tags: Tag[];
  contexts?: PhysicalContext[];
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const displayTags = taskCardDisplayTags(tags, locale);
  const labels = [
    ...[...contexts]
      .sort((a, b) => a.name.localeCompare(b.name, locale))
      .map((context) => ({
        key: `context-${context.id}`,
        name: context.name,
      })),
    ...displayTags.map((tag) => ({
      key: `tag-${tag.id}`,
      name: tag.name,
      color: tag.color,
    })),
  ];
  if (labels.length === 0) return null;

  const visibleLabels = labels.slice(0, 2);
  const overflow = labels.length - visibleLabels.length;
  const overflowLabel =
    contexts.length > 0
      ? strings.moreCardLabels(overflow)
      : strings.moreTaskTags(overflow);

  return (
    <span
      className="task-card-tags"
      role="list"
      aria-label={
        contexts.length > 0 ? strings.cardLabels : strings.taskTags
      }
    >
      {visibleLabels.map((label) => (
        <span
          className="task-card-tag"
          key={label.key}
          role="listitem"
          title={label.name}
          style={
            "color" in label
              ? ({ "--tag-color": label.color } as CSSProperties)
              : undefined
          }
        >
          {label.name}
        </span>
      ))}
      {overflow > 0 ? (
        <span
          className="task-card-tag-overflow"
          role="listitem"
          aria-label={overflowLabel}
          title={overflowLabel}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}
