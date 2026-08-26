import type { Tag, Task } from "@machbar/shared";

function compareConfiguredTags(a: Tag, b: Tag): number {
  const position =
    (a.sortPosition ?? Number.MAX_SAFE_INTEGER) -
    (b.sortPosition ?? Number.MAX_SAFE_INTEGER);
  if (position !== 0) return position;
  const name = a.name.localeCompare(b.name, "de");
  return name !== 0 ? name : a.id - b.id;
}

export function selectPrimaryAreaTag(
  explicitProjectTags: Tag[],
  effectiveTags: Tag[],
  projectTasks: Task[],
): Tag | null {
  const candidates = effectiveTags.filter(
    (tag) => tag.kind === "area" && tag.groupingMode !== "hidden",
  );
  const pinned = candidates
    .filter((tag) => tag.groupingMode === "pinned")
    .sort(compareConfiguredTags);
  if (pinned[0]) return pinned[0];

  const explicitIds = new Set(explicitProjectTags.map((tag) => tag.id));
  const explicit = candidates
    .filter((tag) => explicitIds.has(tag.id))
    .sort(compareConfiguredTags);
  if (explicit[0]) return explicit[0];

  const score = new Map<number, number>();
  for (const task of projectTasks) {
    if (task.status === "done" || task.status === "cancelled") continue;
    for (const tag of task.effectiveAreaTags) {
      score.set(tag.id, (score.get(tag.id) ?? 0) + 1);
    }
  }
  return (
    candidates.sort((a, b) => {
      const scoreDiff = (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0);
      return scoreDiff !== 0 ? scoreDiff : compareConfiguredTags(a, b);
    })[0] ?? null
  );
}
