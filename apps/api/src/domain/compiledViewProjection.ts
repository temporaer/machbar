import type { TaskRecord } from "./graph.js";

/**
 * Rebuilds a TaskRecord's `children` tree for compiled work views (Today,
 * Week, Waiting), which must show only actionable work with References
 * acting as transparent containers: a Reference child is skipped, but its
 * actionable descendants are spliced into the parent's position while
 * preserving relative order.
 *
 * Full outline/detail responses must not use this helper, because they need
 * reference nodes to remain visible as first-class outline entries.
 */
export function pruneReferenceContainers(task: TaskRecord): TaskRecord {
  const flatten = (nodes: TaskRecord[]): TaskRecord[] =>
    nodes.flatMap((node) =>
      node.kind === "reference"
        ? flatten(node.children)
        : [pruneReferenceContainers(node)],
    );

  return {
    ...task,
    children: flatten(task.children),
  };
}
