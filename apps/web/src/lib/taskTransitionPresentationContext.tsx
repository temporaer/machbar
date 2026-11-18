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

interface SectionInput {
  tasks: Task[];
  readSettled: boolean;
  readFailed: boolean;
  signature: string;
}

interface TaskTransitionPresentationValue {
  viewId: string;
  layout: TaskTransitionLayout;
  registerSection(sectionId: string, tasks: Task[], readSettled: boolean, readFailed: boolean): void;
  items(sectionId: string, parentId: number | null, tasks: Task[]): DisplayItem[];
  origin(sectionId: string, task: Task, visualContext?: TaskTransitionVisualContext): TaskTransitionOrigin | undefined;
  isBlocked(taskId: number, revision?: number): boolean;
  hasHeldRows(sectionId: string): boolean;
}

const PresentationContext = createContext<TaskTransitionPresentationValue | null>(null);

let nextViewId = 1;

export function TaskTransitionPresentationProvider({
  identityKey,
  children,
}: {
  identityKey: string;
  children: ReactNode;
}) {
  return <TaskTransitionPresentationOwner identityKey={identityKey}>{children}</TaskTransitionPresentationOwner>;
}

function TaskTransitionPresentationOwner({
  identityKey,
  children,
}: {
  identityKey: string;
  children: ReactNode;
}) {
  const [viewId, setViewId] = useState(() => `task-view:${nextViewId++}`);
  const [layout, setLayout] = useState(emptyTaskTransitionLayout);
  const layoutRef = useRef(layout);
  const identityRef = useRef(identityKey);
  const generation = useRef(0);
  const retired = useRef(false);
  const sections = useRef(new Map<string, SectionInput>());
  const tasksBySection = useRef(new Map<string, Map<number, Task>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const refreshQueued = useRef(false);

  if (identityRef.current !== identityKey) {
    retired.current = true;
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    sections.current.clear();
    tasksBySection.current.clear();
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

  const refreshSections = useCallback(() => {
    updateLayout(current => {
      const projection: Record<string, TaskTransitionSectionProjection> = {};
      for (const [sectionId, input] of sections.current) {
        projection[sectionId] = {
          tasks: input.tasks,
          readSettled: input.readSettled,
          readFailed: input.readFailed,
        };
      }
      return reconcileTaskSections(current, projection);
    });
  }, [updateLayout]);

  const queueRefreshSections = useCallback(() => {
    if (refreshQueued.current) return;
    refreshQueued.current = true;
    queueMicrotask(() => {
      refreshQueued.current = false;
      refreshSections();
    });
  }, [refreshSections]);

  const registerSection = useCallback((
    sectionId: string,
    tasks: Task[],
    readSettled: boolean,
    readFailed: boolean,
  ) => {
    if (!isCurrentOwner()) return;
    const previous = sections.current.get(sectionId);
    const signatureOf = (items: Task[]): string => items.map(task =>
      `${task.id}:${task.revision}[${signatureOf(task.children)}]`).join(",");
    const signature = signatureOf(tasks);
    const taskMap = new Map<number, Task>();
    const visit = (task: Task) => {
      taskMap.set(task.id, task);
      task.children.forEach(visit);
    };
    tasks.forEach(visit);
    tasksBySection.current.set(sectionId, taskMap);
    if (
      previous?.signature === signature &&
      previous.readSettled === readSettled &&
      previous.readFailed === readFailed
    ) {
      sections.current.set(sectionId, { tasks, readSettled, readFailed, signature });
      return;
    }
    sections.current.set(sectionId, { tasks, readSettled, readFailed, signature });
    queueRefreshSections();
  }, [ownerGeneration, queueRefreshSections]);

  const isBlocked = useCallback((taskId: number, revision?: number) => {
    const guard = layoutRef.current.staleGuards[taskId];
    return guard !== undefined && (revision === undefined || revision < guard);
  }, []);

  const origin = useCallback((
    sectionId: string,
    task: Task,
    visualContext?: TaskTransitionVisualContext,
  ): TaskTransitionOrigin | undefined => {
    if (!isCurrentOwner() || !sections.current.has(sectionId)) return undefined;
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
        for (const byId of tasksBySection.current.values()) {
          for (const [id, value] of byId) titles.set(id, value.title);
        }
        const ancestors = taskTransitionOriginAncestors(current, nodeKey, titles);
        const next = beginTaskTransition(
          current, token, nodeKey, sourceTask, intent, ancestors, visualContext,
        );
        if (next === current) return "unavailable";
        updateLayout(() => next);
        return "started";
      },
      reject: token => updateLayout(value => rejectTaskTransition(value, token)),
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
          updateLayout(value => releaseTaskTransition(value, token));
          refreshSections();
        }, TASK_TRANSITION_CONFIRMATION_MS));
      },
    };
    return originRef;
  }, [isBlocked, ownerGeneration, refreshSections, updateLayout, viewId]);

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
    return () => {
      retired.current = true;
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      sections.current.clear();
      tasksBySection.current.clear();
      layoutRef.current = emptyTaskTransitionLayout();
    };
  }, []);

  const value = useMemo<TaskTransitionPresentationValue>(() => ({
    viewId,
    layout,
    registerSection,
    items,
    origin,
    isBlocked,
    hasHeldRows,
  }), [hasHeldRows, isBlocked, items, layout, origin, registerSection, viewId]);

  return <PresentationContext.Provider value={value}>{children}</PresentationContext.Provider>;
}

export function useTaskTransitionPresentation(): TaskTransitionPresentationValue | null {
  return useContext(PresentationContext);
}

export function useTaskTransitionSection(
  sectionId: string | undefined,
  tasks: Task[],
  readSettled = true,
  readFailed = false,
) {
  const presentation = useTaskTransitionPresentation();
  useLayoutEffect(() => {
    if (presentation && sectionId) presentation.registerSection(sectionId, tasks, readSettled, readFailed);
  }, [presentation, readFailed, readSettled, sectionId, tasks]);
  return presentation;
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
