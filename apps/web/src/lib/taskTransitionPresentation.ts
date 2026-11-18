import type { Task, TaskStatus } from "@machbar/shared";

export const TASK_TRANSITION_CONFIRMATION_MS = 3_000;

export type TaskTransitionIntent =
  | "complete"
  | "cancel"
  | "reopen"
  | "actionable"
  | "someday"
  | "captured";

export type TaskTransitionPhase = "pending" | "refreshing" | "confirmed";

export interface TaskTransitionSnapshot {
  id: number;
  title: string;
  status: TaskStatus;
  kind: Task["kind"];
  recurring: boolean;
  visualContext?: TaskTransitionVisualContext;
}

export interface TaskTransitionVisualContext {
  kind: "review";
  reviewKey: string;
  detail: string;
  category: string;
}

export interface TaskDisplayNode {
  key: string;
  taskId: number;
  sectionId: string;
  parentKey: string | null;
  childKeys: string[];
  snapshot?: TaskTransitionSnapshot;
  shellTitle?: string;
}

export interface TaskDisplaySection {
  rootKeys: string[];
}

export interface TaskTransitionOperation {
  token: string;
  nodeKey: string;
  intent: TaskTransitionIntent;
  phase: TaskTransitionPhase;
  baseRevision: number;
  resultRevision?: number;
  resultStatus?: TaskStatus;
  recurringOccurrence: boolean;
}

export interface TaskTransitionOrigin {
  readonly viewId: string;
  readonly nodeKey: string;
  readonly taskId: number;
  readonly visualContext?: TaskTransitionVisualContext;
  isBlocked(revision?: number): boolean;
  begin(token: string, task: Task, intent: TaskTransitionIntent): "started" | "blocked" | "unavailable";
  reject(token: string): void;
  commit(token: string, revision: number, status: TaskStatus): void;
  settled(token: string, readFailed: boolean): void;
}

export interface TaskTransitionLayout {
  nodes: Record<string, TaskDisplayNode>;
  sections: Record<string, TaskDisplaySection>;
  operations: Record<string, TaskTransitionOperation>;
  staleGuards: Record<number, number>;
}

export interface TaskTransitionSectionProjection {
  tasks: Task[];
  readSettled: boolean;
  readFailed: boolean;
}

export function emptyTaskTransitionLayout(): TaskTransitionLayout {
  return { nodes: {}, sections: {}, operations: {}, staleGuards: {} };
}

export function taskTransitionNodeKey(taskId: number): string {
  return `task:${taskId}`;
}

function activeNodeKeys(layout: TaskTransitionLayout): Set<string> {
  return new Set(Object.values(layout.operations).map(operation => operation.nodeKey));
}

function requiredNodeKeys(layout: TaskTransitionLayout, sectionId: string): Set<string> {
  const required = new Set<string>();
  const nodes = Object.values(layout.nodes).filter(node => node.sectionId === sectionId);
  const byKey = new Map(nodes.map(node => [node.key, node]));
  const visit = (key: string) => {
    let node = byKey.get(key);
    while (node && !required.has(node.key)) {
      required.add(node.key);
      node = node.parentKey ? byKey.get(node.parentKey) : undefined;
    }
  };
  for (const key of activeNodeKeys(layout)) visit(key);
  return required;
}

function insertHeldSiblings(current: string[], previous: string[], held: Set<string>): string[] {
  const currentSet = new Set(current);
  const heldHere = previous.filter(key => held.has(key) && !currentSet.has(key));
  if (heldHere.length === 0) return current;
  const before = new Map<string, string[]>();
  const trailing: string[] = [];
  for (const key of heldHere) {
    const oldIndex = previous.indexOf(key);
    const next = previous.slice(oldIndex + 1).find(candidate => currentSet.has(candidate));
    if (next) before.set(next, [...(before.get(next) ?? []), key]);
    else trailing.push(key);
  }
  return [
    ...current.flatMap(key => [...(before.get(key) ?? []), key]),
    ...trailing,
  ];
}

function taskSnapshot(task: Task): TaskTransitionSnapshot {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    kind: task.kind,
    recurring: task.repeatAfterDays !== null,
  };
}

interface SectionSpec {
  key: string;
  task: Task;
  parentKey: string | null;
  childKeys: string[];
}

function sectionSpecs(sectionId: string, tasks: Task[]): {
  specs: Map<string, SectionSpec>;
  roots: string[];
} {
  const specs = new Map<string, SectionSpec>();
  const visit = (task: Task, parentKey: string | null): string => {
    const key = taskTransitionNodeKey(task.id);
    const childKeys = task.children.map(child => visit(child, key));
    specs.set(key, { key, task, parentKey, childKeys });
    return key;
  };
  return { specs, roots: tasks.map(task => visit(task, null)) };
}

function reconcileSectionLayout(
  layout: TaskTransitionLayout,
  sectionId: string,
  tasks: Task[],
): TaskTransitionLayout {
  const { specs, roots } = sectionSpecs(sectionId, tasks);
  const nodes = { ...layout.nodes };
  const sections = { ...layout.sections };
  const operations = layout.operations;
  const staleGuards = layout.staleGuards;
  const active = activeNodeKeys(layout);

  const oldSection = layout.sections[sectionId] ?? { rootKeys: [] };
  const required = requiredNodeKeys({ ...layout, operations }, sectionId);
  for (const [key, spec] of specs) {
    const existing = layout.nodes[key];
    const isHeldElsewhere = active.has(key) && existing?.sectionId !== sectionId;
    if (isHeldElsewhere) continue;
    if (active.has(key) && existing) {
      nodes[key] = { ...existing };
      continue;
    }
    nodes[key] = {
      key,
      taskId: spec.task.id,
      sectionId,
      parentKey: spec.parentKey,
      childKeys: spec.childKeys,
    };
  }

  for (const key of required) {
    const node = layout.nodes[key];
    if (node) nodes[key] = { ...node };
  }

  const sectionHeld = new Set([...required].filter(key => layout.nodes[key]?.sectionId === sectionId));
  for (const [key, spec] of specs) {
    if (active.has(key) && layout.nodes[key]?.sectionId !== sectionId) continue;
    const node = nodes[key];
    if (!node) continue;
    const existingChildren = layout.nodes[key]?.childKeys ?? [];
    node.childKeys = insertHeldSiblings(
      spec.childKeys.filter(childKey => !sectionHeld.has(childKey)),
      existingChildren,
      sectionHeld,
    );
    for (const childKey of node.childKeys) {
      const child = nodes[childKey];
      if (child && !sectionHeld.has(childKey)) child.parentKey = key;
    }
  }

  const rootKeys = insertHeldSiblings(
    roots.filter(key => !sectionHeld.has(key)),
    oldSection.rootKeys,
    sectionHeld,
  );
  sections[sectionId] = { rootKeys };

  const keep = new Set<string>();
  const keepBranch = (key: string) => {
    if (keep.has(key)) return;
    const node = nodes[key];
    if (!node) return;
    keep.add(key);
    for (const child of node.childKeys) keepBranch(child);
  };
  for (const key of rootKeys) keepBranch(key);
  for (const [key, node] of Object.entries(nodes)) {
    if (node.sectionId === sectionId && !keep.has(key)) delete nodes[key];
  }

  return { nodes, sections, operations, staleGuards };
}

export function reconcileTaskSections(
  layout: TaskTransitionLayout,
  projections: Record<string, TaskTransitionSectionProjection>,
): TaskTransitionLayout {
  const sectionSpecs = new Map<string, ReturnType<typeof sectionSpecsForTaskList>>();
  const observations = new Map<number, Array<{
    sectionId: string;
    task: Task;
    readSettled: boolean;
    readFailed: boolean;
  }>>();
  for (const [sectionId, projection] of Object.entries(projections)) {
    const spec = sectionSpecsForTaskList(projection.tasks);
    sectionSpecs.set(sectionId, spec);
    for (const value of spec.specs.values()) {
      const current = observations.get(value.task.id) ?? [];
      current.push({
        sectionId,
        task: value.task,
        readSettled: projection.readSettled,
        readFailed: projection.readFailed,
      });
      observations.set(value.task.id, current);
    }
  }

  const operations = { ...layout.operations };
  const staleGuards = { ...layout.staleGuards };
  const allReadsSettled = Object.values(projections).every(
    projection => projection.readSettled && !projection.readFailed,
  );
  for (const [token, operation] of Object.entries(operations)) {
    const taskId = layout.nodes[operation.nodeKey]?.taskId;
    if (taskId === undefined) {
      delete operations[token];
      continue;
    }
    const currentRevision = observations.get(taskId)?.filter(
      current => current.readSettled && !current.readFailed,
    ).reduce(
      (latest, current) => Math.max(latest, current.task.revision),
      -1,
    ) ?? -1;
    if (
      currentRevision > (operation.resultRevision ?? operation.baseRevision)
    ) {
      delete operations[token];
    }
  }

  for (const [taskIdText, watermark] of Object.entries(staleGuards)) {
    const taskId = Number(taskIdText);
    const currentRevision = observations.get(taskId)?.filter(
      current => current.readSettled && !current.readFailed,
    ).reduce(
      (latest, current) => Math.max(latest, current.task.revision),
      -1,
    ) ?? -1;
    if (currentRevision >= watermark || (currentRevision < 0 && allReadsSettled)) {
      delete staleGuards[taskId];
    }
  }

  const activeLayout = { ...layout, operations, staleGuards };
  const owners = new Map<number, string>();
  for (const [taskId, values] of observations) {
    const activeNode = taskTransitionForTask(activeLayout, taskId);
    const heldSection = activeNode ? layout.nodes[activeNode.nodeKey]?.sectionId : undefined;
    if (heldSection && values.some(value => value.sectionId === heldSection)) {
      owners.set(taskId, heldSection);
      continue;
    }
    values.sort((left, right) =>
      right.task.revision - left.task.revision ||
      left.sectionId.localeCompare(right.sectionId),
    );
    owners.set(taskId, values[0]!.sectionId);
  }

  const result = { ...activeLayout };
  for (const sectionId of Object.keys(projections).sort()) {
    const projection = projections[sectionId]!;
    const filteredTasks = filterTasksForSection(projection.tasks, sectionId, owners);
    Object.assign(result, reconcileSectionLayout(
      result,
      sectionId,
      filteredTasks,
    ));
  }
  return result;
}

function sectionSpecsForTaskList(tasks: Task[]) {
  return sectionSpecs("", tasks);
}

function filterTasksForSection(
  tasks: Task[],
  sectionId: string,
  owners: Map<number, string>,
): Task[] {
  return tasks.flatMap(task => {
    const children = filterTasksForSection(task.children, sectionId, owners);
    if (owners.get(task.id) !== sectionId) return children;
    return [{
      ...task,
      children,
    }];
  });
}

function taskTransitionForTask(
  layout: TaskTransitionLayout,
  taskId: number,
): TaskTransitionOperation | undefined {
  return Object.values(layout.operations).find(operation =>
    layout.nodes[operation.nodeKey]?.taskId === taskId,
  );
}

export function beginTaskTransition(
  layout: TaskTransitionLayout,
  token: string,
  nodeKey: string,
  task: Task,
  intent: TaskTransitionIntent,
  ancestorTitles: Array<{ key: string; title: string }>,
  visualContext?: TaskTransitionVisualContext,
): TaskTransitionLayout {
  const node = layout.nodes[nodeKey];
  const watermark = layout.staleGuards[task.id];
  if (!node || (watermark !== undefined && task.revision < watermark) || layout.operations[token]) return layout;
  const nodes = {
    ...layout.nodes,
    [nodeKey]: {
      ...node,
      snapshot: {
        ...taskSnapshot(task),
        ...(visualContext ? { visualContext } : {}),
      },
    },
  };
  for (const ancestor of ancestorTitles) {
    const ancestorNode = nodes[ancestor.key];
    if (ancestorNode) nodes[ancestor.key] = { ...ancestorNode, shellTitle: ancestor.title };
  }
  return {
    ...layout,
    nodes,
    staleGuards: watermark !== undefined
      ? Object.fromEntries(Object.entries(layout.staleGuards).filter(([id]) => Number(id) !== task.id))
      : layout.staleGuards,
    operations: {
      ...layout.operations,
      [token]: {
        token,
        nodeKey,
        intent,
        phase: "pending",
        baseRevision: task.revision,
        recurringOccurrence: intent === "complete" && task.repeatAfterDays !== null,
      },
    },
  };
}

export function rejectTaskTransition(layout: TaskTransitionLayout, token: string): TaskTransitionLayout {
  const operation = layout.operations[token];
  if (!operation) return layout;
  const operations = { ...layout.operations };
  delete operations[token];
  const nodes = { ...layout.nodes };
  const sectionId = nodes[operation.nodeKey]?.sectionId;
  if (sectionId) {
    const nextLayout = { ...layout, nodes, operations };
    const active = activeNodeKeys(nextLayout);
    const required = requiredNodeKeys(nextLayout, sectionId);
    for (const node of Object.values(nodes)) {
      if (node.sectionId !== sectionId) continue;
      const nextNode = { ...node };
      if (!active.has(node.key)) delete nextNode.snapshot;
      if (!required.has(node.key)) delete nextNode.shellTitle;
      nodes[node.key] = nextNode;
    }
  }
  return { ...layout, nodes, operations };
}

export function commitTaskTransition(
  layout: TaskTransitionLayout,
  token: string,
  resultRevision: number,
  resultStatus: TaskStatus,
): TaskTransitionLayout {
  const operation = layout.operations[token];
  if (!operation) return layout;
  return {
    ...layout,
    operations: {
      ...layout.operations,
      [token]: { ...operation, phase: "refreshing", resultRevision, resultStatus },
    },
    staleGuards: { ...layout.staleGuards, [layout.nodes[operation.nodeKey]!.taskId]: resultRevision },
  };
}

export function confirmTaskTransition(layout: TaskTransitionLayout, token: string): TaskTransitionLayout {
  const operation = layout.operations[token];
  if (!operation) return layout;
  return {
    ...layout,
    operations: {
      ...layout.operations,
      [token]: { ...operation, phase: "confirmed" },
    },
  };
}

export function releaseTaskTransition(layout: TaskTransitionLayout, token: string): TaskTransitionLayout {
  return rejectTaskTransition(layout, token);
}

export function taskTransitionForNode(
  layout: TaskTransitionLayout,
  nodeKey: string,
): TaskTransitionOperation | null {
  return Object.values(layout.operations).find(operation => operation.nodeKey === nodeKey) ?? null;
}

export function taskTransitionIsHeld(layout: TaskTransitionLayout, nodeKey: string): boolean {
  return Object.values(layout.operations).some(operation => {
    let current = layout.nodes[operation.nodeKey];
    while (current) {
      if (current.key === nodeKey) return true;
      current = current.parentKey ? layout.nodes[current.parentKey] : undefined;
    }
    return false;
  });
}

export function taskTransitionDisplayChildren(
  layout: TaskTransitionLayout,
  sectionId: string,
  parentKey: string | null,
  freshTasks: Task[],
): Array<{ task: Task } | { node: TaskDisplayNode; children: TaskDisplayNode[] }> {
  const parent = parentKey ? layout.nodes[parentKey] : null;
  const keys = parent ? parent.childKeys : layout.sections[sectionId]?.rootKeys ?? [];
  const fresh = new Map(freshTasks.map(task => [taskTransitionNodeKey(task.id), task]));
  const result: Array<{ task: Task } | { node: TaskDisplayNode; children: TaskDisplayNode[] }> = [];
  for (const key of keys) {
    const node = layout.nodes[key];
    if (!node || node.sectionId !== sectionId) continue;
    const currentTask = fresh.get(key);
    if (currentTask && node.parentKey === parentKey) {
      result.push({ task: currentTask });
      continue;
    }
    if (!taskTransitionIsHeld(layout, key)) continue;
    const heldChildren = node.childKeys
      .map(childKey => layout.nodes[childKey])
      .filter((child): child is TaskDisplayNode => child !== undefined && taskTransitionIsHeld(layout, child.key));
    result.push({ node, children: heldChildren });
  }
  return result;
}

export function taskTransitionOriginAncestors(
  layout: TaskTransitionLayout,
  nodeKey: string,
  titles: Map<number, string>,
): Array<{ key: string; title: string }> {
  const result: Array<{ key: string; title: string }> = [];
  let node = layout.nodes[nodeKey]?.parentKey ? layout.nodes[layout.nodes[nodeKey]!.parentKey!] : undefined;
  while (node) {
    const title = titles.get(node.taskId);
    if (title !== undefined) result.push({ key: node.key, title });
    node = node.parentKey ? layout.nodes[node.parentKey] : undefined;
  }
  return result;
}
