import type { TaskSize } from "@machbar/shared";

const SIZE_CYCLE: ReadonlyArray<TaskSize | null> = [null, "S", "M", "L", "XL"];

export function nextSizeInCycle(current: TaskSize | null): TaskSize | null {
  const index = SIZE_CYCLE.indexOf(current);
  const nextIndex = (index + 1) % SIZE_CYCLE.length;
  return SIZE_CYCLE[nextIndex] ?? null;
}
