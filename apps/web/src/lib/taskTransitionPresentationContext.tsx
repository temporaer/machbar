import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Task } from "@machbar/shared";
import {
  beginTaskTransition,
  commitTaskTransition,
  confirmTaskTransition,
  emptyTaskTransitionLayout,
  reconcileTaskSections,
  rejectTaskTransition,
  releaseTaskTransition,
  taskTransitionDisplayChildren,
  taskTransitionForNode,
  taskTransitionNodeKey,
  taskTransitionOriginAncestors,
  TASK_TRANSITION_CONFIRMATION_MS,
  type TaskDisplayNode,
  type TaskTransitionIntent,
  type TaskTransitionLayout,
  type TaskTransitionOperation,
  type TaskTransitionOrigin,
  type TaskTransitionSectionProjection,
  type TaskTransitionVisualContext,
} from "./taskTransitionPresentation";

type DisplayItem =
  | { kind: "live"; task: Task; transition: TaskTransitionOperation | null }
  | { kind: "departure"; node: TaskDisplayNode; children: DisplayItem[] };

interface TaskTransitionPresentationValue {
  viewId: string;
  layout: TaskTransitionLayout;
  replaceProjection(projection: Record<string, TaskTransitionSectionProjection>): void;
  items(sectionId: string, parentId: number | null, tasks: Task[]): DisplayItem[];
  origin(sectionId: string, task: Task, visualContext?: TaskTransitionVisualContext): TaskTransitionOrigin | undefined;
  isBlocked(taskId: number, revision?: number): boolean;
  hasHeldRows(sectionId: string): boolean;
}

const PresentationContext = createContext<TaskTransitionPresentationValue | null>(null);

let nextViewId = 1;

export function TaskTransitionPresentationProvider({
  identityKey,
  projection,
  children,
}: {
  identityKey: string;
  projection: Record<string, TaskTransitionSectionProjection>;
  children: ReactNode;
}) {
  return (
    <TaskTransitionPresentationOwner identityKey={identityKey} projection={projection}>
      {children}
    </TaskTransitionPresentationOwner>
  );
}

function TaskTransitionPresentationOwner({
  identityKey,
  projection: nextProjection,
  children,
}: {
  identityKey: string;
  projection: Record<string, TaskTransitionSectionProjection>;
  children: ReactNode;
}) {
  const [viewId, setViewId] = useState(() => `task-view:${nextViewId++}`);
  const [layout, setLayout] = useState(emptyTaskTransitionLayout);
  const layoutRef = useRef(layout);
  const identityRef = useRef(identityKey);
  const generation = useRef(0);
  const retired = useRef(false);
  const projection = useRef<Record<string, TaskTransitionSectionProjection>>({});
  const appliedProjectionSignature = useRef<string | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  if (identityRef.current !== identityKey) {
    retired.current = true;
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    projection.current = {};
    appliedProjectionSignature.current = null;
    generation.current += 1;
    identityRef.current = identityKey;
    retired.current = false;
    const emptyLayout = emptyTaskTransitionLayout();
    layoutRef.current = emptyLayout;
    setLayout(emptyLayout);
    setViewId(`task-view:${nextViewId++}`);
  }
  const ownerGeneration = generation.current;
  const isCurrentOwner = () =>
    !retired.current && generation.current === ownerGeneration;

  const updateLayout = useCallback((update: (current: TaskTransitionLayout) => TaskTransitionLayout) => {
    if (!isCurrentOwner()) return;
    const next = update(layoutRef.current);
    if (next === layoutRef.current) return;
    layoutRef.current = next;
    setLayout(next);
  }, [ownerGeneration]);

  const replaceProjection = useCallback((
    nextProjection: Record<string, TaskTransitionSectionProjection>,
  ) => {
    if (!isCurrentOwner()) return;
    projection.current = nextProjection;
    updateLayout(current => reconcileTaskSections(current, nextProjection));
  }, [ownerGeneration, updateLayout]);
  const settleLayout = useCallback((
    update: (current: TaskTransitionLayout) => TaskTransitionLayout,
  ) => {
    updateLayout(current => reconcileTaskSections(update(current), projection.current));
  }, [updateLayout]);

  const nextProjectionSignature = projectionSignature(nextProjection);
  useLayoutEffect(() => {
    if (appliedProjectionSignature.current === nextProjectionSignature) return;
    appliedProjectionSignature.current = nextProjectionSignature;
    replaceProjection(nextProjection);
  }, [nextProjection, nextProjectionSignature, replaceProjection]);

  const isBlocked = useCallback((taskId: number, revision?: number) => {
    const guard = layoutRef.current.staleGuards[taskId];
    return guard !== undefined && (revision === undefined || revision < guard);
  }, []);

  const origin = useCallback((
    sectionId: string,
    task: Task,
    visualContext?: TaskTransitionVisualContext,
  ): TaskTransitionOrigin | undefined => {
    if (!isCurrentOwner() || !projection.current[sectionId]) return undefined;
    const nodeKey = taskTransitionNodeKey(task.id);
    const initialNode = layoutRef.current.nodes[nodeKey];
    if (!initialNode || initialNode.sectionId !== sectionId) return undefined;
    const originRef: TaskTransitionOrigin = {
      viewId,
      nodeKey,
      taskId: task.id,
      ...(visualContext ? { visualContext } : {}),
      isBlocked: () => isCurrentOwner() && isBlocked(task.id, task.revision),
      begin: (token, sourceTask, intent) => {
        if (!isCurrentOwner()) return "unavailable";
        if (isBlocked(sourceTask.id, sourceTask.revision)) return "blocked";
        const current = layoutRef.current;
        const currentNode = current.nodes[nodeKey];
        if (!currentNode || currentNode.sectionId !== sectionId) return "unavailable";
        const titles = new Map<number, string>();
        const visit = (task: Task) => {
          titles.set(task.id, task.title);
          task.children.forEach(visit);
        };
        for (const section of Object.values(projection.current)) {
          section.tasks.forEach(visit);
        }
        const ancestors = taskTransitionOriginAncestors(current, nodeKey, titles);
        const next = beginTaskTransition(
          current, token, nodeKey, sourceTask, intent, ancestors, visualContext,
        );
        if (next === current) return "unavailable";
        updateLayout(() => next);
        return "started";
      },
      reject: token => settleLayout(value => rejectTaskTransition(value, token)),
      commit: (token, revision, status) => updateLayout(value =>
        commitTaskTransition(value, token, revision, status)),
      settled: token => {
        if (!isCurrentOwner()) return;
        updateLayout(value => confirmTaskTransition(value, token));
        const existing = timers.current.get(token);
        if (existing) clearTimeout(existing);
        timers.current.set(token, setTimeout(() => {
          if (!isCurrentOwner()) return;
          timers.current.delete(token);
          settleLayout(value => releaseTaskTransition(value, token));
        }, TASK_TRANSITION_CONFIRMATION_MS));
      },
    };
    return originRef;
  }, [isBlocked, ownerGeneration, settleLayout, updateLayout, viewId]);

  const items = useCallback((sectionId: string, parentId: number | null, tasks: Task[]): DisplayItem[] => {
    const current = layoutRef.current;
    if (!current.sections[sectionId]) {
      return tasks.map(task => ({
        kind: "live",
        task,
        transition: taskTransitionForNode(current, taskTransitionNodeKey(task.id)),
      }));
    }
    const parentKey = parentId === null ? null : taskTransitionNodeKey(parentId);
    const project = (parent: string | null, fresh: Task[]): DisplayItem[] =>
      taskTransitionDisplayChildren(current, sectionId, parent, fresh).map(item => {
        if ("task" in item) {
          return {
            kind: "live",
            task: item.task,
            transition: taskTransitionForNode(current, taskTransitionNodeKey(item.task.id)),
          };
        }
        return {
          kind: "departure",
          node: item.node,
          children: project(item.node.key, []),
        };
      });
    return project(parentKey, tasks);
  }, []);

  const hasHeldRows = useCallback((sectionId: string) =>
    Object.values(layout.operations).some(operation =>
      layout.nodes[operation.nodeKey]?.sectionId === sectionId), [layout]);

  useLayoutEffect(() => {
    retired.current = false;
    projection.current = nextProjection;
    appliedProjectionSignature.current = nextProjectionSignature;
    const initialLayout = reconcileTaskSections(emptyTaskTransitionLayout(), nextProjection);
    layoutRef.current = initialLayout;
    setLayout(initialLayout);
    return () => {
      retired.current = true;
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      projection.current = {};
      appliedProjectionSignature.current = null;
      layoutRef.current = emptyTaskTransitionLayout();
    };
  }, []);

  const value = useMemo<TaskTransitionPresentationValue>(() => ({
    viewId,
    layout,
    replaceProjection,
    items,
    origin,
    isBlocked,
    hasHeldRows,
  }), [hasHeldRows, isBlocked, items, layout, origin, replaceProjection, viewId]);

  return <PresentationContext.Provider value={value}>{children}</PresentationContext.Provider>;
}

export function useTaskTransitionPresentation(): TaskTransitionPresentationValue | null {
  return useContext(PresentationContext);
}

function projectionSignature(sections: Record<string, TaskTransitionSectionProjection>): string {
  const taskSignature = (tasks: Task[]): string => tasks.map(task =>
    `${task.id}:${task.revision}:${task.status}:${task.title}[${taskSignature(task.children)}]`,
  ).join(",");
  return Object.entries(sections)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, section]) =>
      `${id}:${section.readSettled ? "settled" : "pending"}:${section.readFailed ? "failed" : "ok"}:${taskSignature(section.tasks)}`,
    )
    .join("|");
}

export function TaskTransitionSection({
  sectionId,
  tasks,
  children,
  emptyFallback = null,
  keep = false,
}: {
  sectionId: string;
  tasks: Task[];
  children: ReactNode;
  emptyFallback?: ReactNode;
  keep?: boolean;
}) {
  const presentation = useTaskTransitionPresentation();
  if (!presentation) return children;
  if (tasks.length === 0 && !presentation.hasHeldRows(sectionId) && !keep) return emptyFallback;
  return children;
}

export function TaskTransitionEmptyState({
  sectionIds,
  children,
}: {
  sectionIds: string[];
  children: ReactNode;
}) {
  const presentation = useTaskTransitionPresentation();
  return sectionIds.some(sectionId => presentation?.hasHeldRows(sectionId)) ? null : children;
}

export type { DisplayItem as TaskTransitionDisplayItem };
