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
  findTaskListPositions,
  type TaskListTransition,
  type TaskListTransitionEntry,
} from "./taskListTransitionPresentation";

export const TASK_TRANSITION_CONFIRMATION_MS = 3_000;

interface TaskListTransitionFeedbackValue {
  get: (taskId: number, outlineId?: string) => TaskListTransition | undefined;
  registerOutline: (outlineId: string) => () => void;
  updateOutline: (outlineId: string, tasks: ReadonlyMap<number, Task>, roots: readonly Task[]) => void;
  transitions: () => TaskListTransitionEntry[];
  hasTransitions: (outlineId: string) => boolean;
  renderableOutlineIds: () => ReadonlySet<string>;
}

interface StoredTransition extends TaskListTransitionEntry {
  token: number;
}

const TaskListTransitionFeedbackContext =
  createContext<TaskListTransitionFeedbackValue | null>(null);

interface RegisteredOutline {
  tasks: ReadonlyMap<number, Task>;
  positions: ReadonlyMap<number, NonNullable<TaskListTransition["sourcePath"]>>;
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
  const [registeredOutlineIds, setRegisteredOutlineIds] = useState<ReadonlySet<string>>(() => new Set());

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
    const next = new Map(entriesRef.current);
    next.delete(taskId);
    replaceEntries(next);
  }, [replaceEntries]);

  const registerOutline = useCallback((outlineId: string) => {
    if (!outlines.current.has(outlineId)) {
      outlines.current.set(outlineId, { tasks: new Map(), positions: new Map() });
      setRegisteredOutlineIds(new Set(outlines.current.keys()));
    }
    return () => {
      if (outlines.current.delete(outlineId)) {
        setRegisteredOutlineIds(new Set(outlines.current.keys()));
      }
    };
  }, []);

  const updateOutline = useCallback((outlineId: string, tasks: ReadonlyMap<number, Task>, roots: readonly Task[]) => {
    const positions = findTaskListPositions(roots);
    outlines.current.set(outlineId, { tasks, positions });
    const available = currentTasks(outlines.current);
    const next = new Map(entriesRef.current);
    let entriesChanged = false;
    for (const [id, entry] of next) {
      const fresh = available.get(id);
      if (!fresh) continue;
      if (entry.event.phase === "success" && entry.event.resultRevision !== undefined &&
        fresh.revision > entry.event.resultRevision) {
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
      } else if (fresh.revision > entry.task.revision) {
        next.set(id, { ...entry, task: { ...fresh, children: [] } });
        entriesChanged = true;
      }
    }
    if (entriesChanged) replaceEntries(next);
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
    const sourcePath = previous?.sourcePath ??
      sourceOutline?.[1].positions.get(event.taskId) ?? null;
    const next = new Map(entriesRef.current);
    next.set(event.taskId, {
      task: { ...((task && task.revision >= (previous?.task.revision ?? 0) ? task : previous!.task)), children: [] },
      event,
      token,
      sourceOutlineId: previous ? previous.sourceOutlineId : sourceOutline?.[0] ?? null,
      sourcePath,
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
  const transitions = useCallback(() => [...entries.values()], [entries]);
  const hasTransitions = useCallback((outlineId: string) =>
    [...entries.values()].some(entry => entry.sourceOutlineId === outlineId),
  [entries]);
  const renderableOutlineIds = useCallback(() => registeredOutlineIds, [registeredOutlineIds]);

  const value: TaskListTransitionFeedbackValue = {
    get,
    registerOutline,
    updateOutline,
    transitions,
    hasTransitions,
    renderableOutlineIds,
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
  roots: readonly Task[],
) {
  const feedback = useRequiredTaskListTransitionFeedback();
  const taskMap = useMemo(() => new Map(flattenTasks(tasks).map(task => [task.id, task])), [tasks]);
  useLayoutEffect(() => feedback.registerOutline(outlineId), [feedback.registerOutline, outlineId]);
  useLayoutEffect(() => feedback.updateOutline(outlineId, taskMap, roots), [feedback.updateOutline, outlineId, taskMap, roots]);
}
