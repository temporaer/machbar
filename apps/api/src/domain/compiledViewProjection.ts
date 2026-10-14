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
 * Today also supplies a window predicate for embedded execution suggestions;
 * the root's attention eligibility remains the agenda compiler's decision.
 */
export function pruneReferenceContainers(
  task: TaskRecord,
  isAvailable: (task: TaskRecord) => boolean = () => true,
): TaskRecord {
  const flatten = (nodes: TaskRecord[]): TaskRecord[] =>
    nodes.flatMap((node) =>
      node.kind === "reference"
        ? flatten(node.children)
        : isAvailable(node) ? [pruneReferenceContainers(node, isAvailable)] : [],
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
  isAvailable: (task: TaskRecord) => boolean = () => true,
): ProjectRecord {
  const pruneOptionalTask = (
    task: TaskRecord | null | undefined,
  ): TaskRecord | null | undefined =>
    task === undefined
      ? undefined
      : task === null || !isAvailable(task)
        ? null
        : pruneReferenceContainers(task, isAvailable);

  return {
    ...project,
    nextAction: pruneOptionalTask(project.nextAction),
    deferredNextAction: pruneOptionalTask(project.deferredNextAction),
    additionalNextActions: project.additionalNextActions?.filter(isAvailable).map(
      (task) => pruneReferenceContainers(task, isAvailable),
    ),
    childStories: project.childStories.map((child) => pruneProjectForCompiledView(child, isAvailable)),
  };
}
