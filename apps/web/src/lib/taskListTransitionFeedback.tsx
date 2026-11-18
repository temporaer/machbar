import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Task } from "@machbar/shared";
import { isReadAccessError } from "./errorMessage";
import { flattenTasks } from "./taskHelpers";
import { useTaskActions } from "./useTaskActions";
import {
  removeTransitionAndRebase,
  transitionSourceIndex,
  type TaskListTransition,
} from "./taskListTransitionPresentation";

export const TASK_TRANSITION_CONFIRMATION_MS = 3_000;

interface TaskListTransitionFeedbackValue {
  get: (taskId: number, outlineId?: string) => TaskListTransition | undefined;
  registerOutline: (
    outlineId: string,
    tasks: ReadonlyMap<number, Task>,
    rootTaskIds: readonly number[],
  ) => () => void;
  departures: (outlineId: string, taskIds: ReadonlySet<number>) => TaskListTransition[];
  orphanedDepartures: () => TaskListTransition[];
}

interface StoredTransition extends TaskListTransition {
  token: number;
  sourceOutlineId: string | null;
  sourceIndex: number | null;
}

const TaskListTransitionFeedbackContext =
  createContext<TaskListTransitionFeedbackValue | null>(null);

interface RegisteredOutline {
  tasks: ReadonlyMap<number, Task>;
  rootTaskIds: readonly number[];
}

function currentTasks(outlines: Map<string, RegisteredOutline>) {
  const tasks = new Map<number, Task>();
  for (const outline of outlines.values()) {
    for (const [id, task] of outline.tasks) tasks.set(id, task);
  }
  return tasks;
}

export function TaskListTransitionFeedbackProvider({
  children,
  identityKey,
}: {
  children: ReactNode;
  identityKey: string;
}) {
  const actions = useTaskActions();
  const queryClient = useQueryClient();
  const outlines = useRef(new Map<string, RegisteredOutline>());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextToken = useRef(0);
  const entriesRef = useRef(new Map<number, StoredTransition>());
  const retiredTransitions = useRef(new Set<number>());
  const identityRef = useRef(identityKey);
  const [entries, setEntries] = useState(entriesRef.current);
  const [, setRegistryVersion] = useState(0);

  const replaceEntries = useCallback((next: Map<number, StoredTransition>) => {
    entriesRef.current = next;
    setEntries(next);
  }, []);
  const retireEntries = useCallback(() => {
    for (const [taskId, entry] of entriesRef.current) {
      if (entry.event.phase === "pending") retiredTransitions.current.add(taskId);
    }
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    replaceEntries(new Map());
  }, [replaceEntries]);

  const remove = useCallback((taskId: number, token?: number) => {
    const current = entriesRef.current.get(taskId);
    if (!current || (token !== undefined && current.token !== token)) return;
    const timer = timers.current.get(taskId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(taskId);
    }
    const sourceOutline = current.sourceOutlineId
      ? outlines.current.get(current.sourceOutlineId)
      : undefined;
    const next = sourceOutline
      ? removeTransitionAndRebase(
          entriesRef.current,
          taskId,
          new Set(sourceOutline.tasks.keys()),
        )
      : new Map(entriesRef.current);
    next.delete(taskId);
    replaceEntries(next);
  }, [replaceEntries]);

  const registerOutline = useCallback((outlineId: string, tasks: ReadonlyMap<number, Task>, rootTaskIds: readonly number[]) => {
    outlines.current.set(outlineId, { tasks, rootTaskIds });
    const available = currentTasks(outlines.current);
    const next = new Map(entriesRef.current);
    let entriesChanged = false;
    for (const [id, entry] of next) {
      const fresh = available.get(id);
      if (!fresh) continue;
      if (entry.event.phase === "success" && entry.event.resultRevision !== undefined &&
        fresh.revision > entry.event.resultRevision && fresh.status !== entry.event.targetStatus) {
        const timer = timers.current.get(id);
        if (timer !== undefined) clearTimeout(timer);
        timers.current.delete(id);
        next.delete(id);
        entriesChanged = true;
      } else if (entry.event.phase === "pending" && fresh.revision > entry.event.sourceRevision &&
        fresh.status !== entry.event.targetStatus) {
        const timer = timers.current.get(id);
        if (timer !== undefined) clearTimeout(timer);
        timers.current.delete(id);
        next.delete(id);
        entriesChanged = true;
      } else if (fresh.revision >= entry.task.revision) {
        next.set(id, { ...entry, task: { ...fresh, children: [] } });
        entriesChanged = true;
      }
    }
    if (entriesChanged) replaceEntries(next);
    setRegistryVersion(version => version + 1);
    return () => {
      outlines.current.delete(outlineId);
      setRegistryVersion(version => version + 1);
    };
  }, [replaceEntries]);

  useLayoutEffect(() => {
    if (identityRef.current === identityKey) return;
    identityRef.current = identityKey;
    retireEntries();
  }, [identityKey, retireEntries]);

  useEffect(() => queryClient.getQueryCache().subscribe(event => {
    if (event.type === "updated" && event.action.type === "error" &&
      isReadAccessError(event.action.error)) retireEntries();
  }), [queryClient, retireEntries]);

  useLayoutEffect(() => actions.subscribeTransitionFeedback(event => {
    if (retiredTransitions.current.has(event.taskId)) {
      if (event.phase !== "pending") retiredTransitions.current.delete(event.taskId);
      return;
    }
    const task = currentTasks(outlines.current).get(event.taskId);
    const sourceOutline = [...outlines.current].find(([, outline]) => outline.tasks.has(event.taskId));
    const previous = entriesRef.current.get(event.taskId);
    if (event.phase === "failure") {
      remove(event.taskId);
      return;
    }
    if (event.phase === "success" && !previous) return;
    if (!task && !previous) return;
    const token = event.phase === "pending" ? ++nextToken.current : previous!.token;
    const sourceIndex = previous?.sourceIndex ?? transitionSourceIndex(
      sourceOutline?.[1].rootTaskIds ?? [],
      event.taskId,
      sourceOutline?.[0],
      entriesRef.current.values(),
      new Set(currentTasks(outlines.current).keys()),
    );
    const next = new Map(entriesRef.current);
    next.set(event.taskId, {
      task: { ...((task && task.revision >= (previous?.task.revision ?? 0) ? task : previous!.task)), children: [] },
      event,
      token,
      sourceOutlineId: previous ? previous.sourceOutlineId : sourceOutline?.[0] ?? null,
      sourceIndex,
    });
    replaceEntries(next);
    if (event.phase === "success") {
      const timer = timers.current.get(event.taskId);
      if (timer !== undefined) clearTimeout(timer);
      timers.current.set(event.taskId, setTimeout(() => remove(event.taskId, token), TASK_TRANSITION_CONFIRMATION_MS));
    }
  }), [actions.subscribeTransitionFeedback, remove, replaceEntries]);

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    entriesRef.current.clear();
  }, []);

  const get = useCallback((taskId: number, outlineId?: string) => {
    const entry = entries.get(taskId);
    return entry && (
      !outlineId ||
      !entry.sourceOutlineId ||
      entry.sourceOutlineId === outlineId ||
      outlines.current.get(outlineId)?.tasks.has(taskId) ||
      !outlines.current.has(entry.sourceOutlineId)
    )
      ? entry
      : undefined;
  }, [entries]);
  const departures = useCallback((outlineId: string, taskIds: ReadonlySet<number>) => {
    const visibleElsewhere = new Set<number>();
    for (const [id, outline] of outlines.current) {
      if (id === outlineId) continue;
      for (const taskId of outline.tasks.keys()) visibleElsewhere.add(taskId);
    }
    return [...entries.values()].filter(entry =>
      !taskIds.has(entry.event.taskId) &&
      !visibleElsewhere.has(entry.event.taskId) &&
      (entry.sourceOutlineId === outlineId || !entry.sourceOutlineId),
    );
  }, [entries]);
  const orphanedDepartures = useCallback(() => {
    const visible = new Set(currentTasks(outlines.current).keys());
    return [...entries.values()].filter(entry =>
      !visible.has(entry.event.taskId) &&
      (entry.sourceOutlineId === null || !outlines.current.has(entry.sourceOutlineId)),
    );
  }, [entries]);

  const value: TaskListTransitionFeedbackValue = {
      get,
      registerOutline,
      departures,
      orphanedDepartures,
    };
  return (
    <TaskListTransitionFeedbackContext.Provider value={value}>
      {children}
    </TaskListTransitionFeedbackContext.Provider>
  );
}

export function useTaskListTransitionFeedback() {
  return useContext(TaskListTransitionFeedbackContext);
}

export function useRequiredTaskListTransitionFeedback() {
  const feedback = useTaskListTransitionFeedback();
  if (!feedback) throw new Error("Task list transition feedback requires an explicit view owner");
  return feedback;
}

export function useRegisterTaskOutline(
  outlineId: string,
  tasks: Task[],
  rootTaskIds: readonly number[],
) {
  const feedback = useRequiredTaskListTransitionFeedback();
  const taskMap = useMemo(() => new Map(flattenTasks(tasks).map(task => [task.id, task])), [tasks]);
  useLayoutEffect(() => feedback.registerOutline(outlineId, taskMap, rootTaskIds), [feedback.registerOutline, outlineId, taskMap, rootTaskIds]);
}
