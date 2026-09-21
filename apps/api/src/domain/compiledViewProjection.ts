import type { ProjectRecord, TaskRecord } from "./graph.js";

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

/**
 * Rebuilds a ProjectRecord for compiled work views. Project metadata and the
 * child-project hierarchy remain intact, while every embedded task projection
 * uses the same transparent Reference-container pruning as task views.
 *
 * Full project detail/list/outline responses must not use this helper.
 */
export function pruneProjectForCompiledView(
  project: ProjectRecord,
): ProjectRecord {
  const pruneOptionalTask = (
    task: TaskRecord | null | undefined,
  ): TaskRecord | null | undefined =>
    task === undefined
      ? undefined
      : task === null
        ? null
        : pruneReferenceContainers(task);

  return {
    ...project,
    nextAction: pruneOptionalTask(project.nextAction),
    deferredNextAction: pruneOptionalTask(project.deferredNextAction),
    additionalNextActions: project.additionalNextActions?.map(
      pruneReferenceContainers,
    ),
    childStories: project.childStories.map(pruneProjectForCompiledView),
  };
}
