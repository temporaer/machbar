import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueryClient, type Query } from "@tanstack/react-query";
import {
  CompletionFeedbackOwnerProvider,
  TaskCommandEligibilityProvider,
  useTaskActions,
  type CompletionFeedbackOwner,
  type TaskFeedbackAction,
} from "../lib/useTaskActions";
import { useStrings } from "../lib/strings";
import { isReadAccessError } from "../lib/errorMessage";
import type { ReadAccessResource } from "../lib/useAsync";
import { useViewTaskCommandEligibility } from "../lib/useViewTaskCommandEligibility";

const InlineCompletionContext = createContext<ReadonlySet<number>>(new Set());

export function useInlineCompletionAcknowledgement(taskId: number) {
  return useContext(InlineCompletionContext).has(taskId);
}

interface CompletionNotice {
  taskId: number;
  title: string;
  recurring: boolean;
  action: TaskFeedbackAction;
  expiresAt: number;
  sequence: number;
}

function queryContainsTask(query: Query, taskId: number, title: string): boolean {
  const visited = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== "object") return false;
    if (visited.has(value)) return false;
    visited.add(value);
    if (Array.isArray(value)) return value.some(visit);
    const record = value as Record<string, unknown>;
    if (record.id === taskId && record.title === title && typeof record.status === "string") return true;
    return Object.values(record).some(visit);
  };
  return visit(query.state.data);
}

export function ViewCompletionNotice({
  accessResource,
  enabled,
  readUnavailable,
  children,
}: {
  accessResource: ReadAccessResource;
  enabled: boolean;
  readUnavailable: boolean;
  children: ReactNode;
}) {
  const strings = useStrings();
  const client = useQueryClient();
  const { registerCompletionFeedback, pendingIds } = useTaskActions();
  const { accessGeneration, accessAvailable, scope: commandEligibility } =
    useViewTaskCommandEligibility({ accessResource, enabled, readUnavailable });
  const owner = useMemo<CompletionFeedbackOwner>(
    () => Symbol("view-completion"),
    [accessGeneration, accessResource],
  );
  const available = enabled && accessAvailable;
  const availableRef = useRef(available);
  const [notice, setNotice] = useState<CompletionNotice | null>(null);
  const [inlineAcknowledgements, setInlineAcknowledgements] = useState<ReadonlySet<number>>(() => new Set());
  const noticeRef = useRef(notice);
  const pendingIdsRef = useRef(pendingIds);
  const deniedTaskIds = useRef(new Set<number>());
  const inlineTimers = useRef(new Map<number, { query: Query; timer: ReturnType<typeof setTimeout> }>());
  const previousResource = useRef(accessResource);
  const previousAccessGeneration = useRef(accessGeneration);
  noticeRef.current = notice;
  pendingIdsRef.current = pendingIds;
  availableRef.current = available;
  useLayoutEffect(() => {
    if (previousResource.current === accessResource) return;
    previousResource.current = accessResource;
    deniedTaskIds.current.clear();
    noticeRef.current = null;
    setNotice(null);
    for (const { timer } of inlineTimers.current.values()) clearTimeout(timer);
    inlineTimers.current.clear();
    setInlineAcknowledgements(new Set());
  }, [accessResource]);
  useLayoutEffect(() => {
    if (previousAccessGeneration.current === accessGeneration) return;
    previousAccessGeneration.current = accessGeneration;
    deniedTaskIds.current.clear();
    noticeRef.current = null;
    setNotice(null);
    for (const { timer } of inlineTimers.current.values()) clearTimeout(timer);
    inlineTimers.current.clear();
    setInlineAcknowledgements(new Set());
  }, [accessGeneration]);
  useLayoutEffect(() => {
    if (!available) {
      noticeRef.current = null;
      setNotice(null);
      for (const { timer } of inlineTimers.current.values()) clearTimeout(timer);
      inlineTimers.current.clear();
      setInlineAcknowledgements(new Set());
      return;
    }
    return registerCompletionFeedback(owner, {
      pendingMessage: action => ({
        complete: strings.taskCompleting,
        cancel: strings.taskCancelling,
        reopen: strings.taskReopening,
        captured: strings.taskCapturing,
        actionable: strings.taskMakingActionable,
        someday: strings.taskMovingToSomeday,
      })[action],
      refreshOptions: completion => {
        if (completion.action !== "complete" || !completion.inlineCompletion || accessResource.type !== "view") return undefined;
        const candidates = client.getQueryCache().findAll({
          type: "active",
          predicate: query => {
            const resource = query.meta?.accessResource as ReadAccessResource | undefined;
            return resource?.type === "view" && resource.key === accessResource.key &&
              queryContainsTask(query, completion.taskId, completion.title);
          },
        });
        const sourceQuery: Query | null = candidates.length === 1 ? candidates[0] ?? null : null;
        return sourceQuery ? { deferQuery: sourceQuery, delayMs: 3_000 } : undefined;
      },
      onCommitted: completion => {
        if (!availableRef.current || deniedTaskIds.current.has(completion.taskId)) return;
        const sourceQuery = completion.sourceQuery ?? null;
        if (completion.action === "complete" && completion.inlineCompletion && sourceQuery) {
          setInlineAcknowledgements(current => new Set(current).add(completion.taskId));
          const idsToRenew = new Set([completion.taskId]);
          for (const [taskId, entry] of inlineTimers.current) {
            if (entry.query !== sourceQuery && taskId !== completion.taskId) continue;
            clearTimeout(entry.timer);
            if (entry.query === sourceQuery) idsToRenew.add(taskId);
          }
          const startTimer = (taskId: number) => inlineTimers.current.set(taskId, {
            query: sourceQuery,
            timer: setTimeout(() => {
              inlineTimers.current.delete(taskId);
              setInlineAcknowledgements(current => {
                const next = new Set(current);
                next.delete(taskId);
                return next;
              });
            }, 3_000),
          });
          for (const taskId of idsToRenew) startTimer(taskId);
          return;
        }
        const next = {
          ...completion,
          expiresAt: Date.now() + 3_000,
          sequence: (noticeRef.current?.sequence ?? 0) + 1,
        };
        noticeRef.current = next;
        setNotice(next);
      },
    });
  }, [
    accessGeneration,
    accessResource,
    available,
    owner,
    registerCompletionFeedback,
    strings,
    client,
    accessResource,
  ]);
  useLayoutEffect(() => {
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type !== "updated") return;
      if (event.query.state.fetchStatus === "fetching") {
        const retiredIds: number[] = [];
        for (const [taskId, entry] of inlineTimers.current) {
          if (entry.query !== event.query) continue;
          clearTimeout(entry.timer);
          inlineTimers.current.delete(taskId);
          retiredIds.push(taskId);
        }
        if (retiredIds.length) {
          setInlineAcknowledgements(current => {
            const next = new Set(current);
            retiredIds.forEach(taskId => next.delete(taskId));
            return next;
          });
        }
      }
      const resource = event.query.meta?.accessResource as ReadAccessResource | undefined;
      if (!isReadAccessError(event.query.state.error) || resource?.type !== "task") return;
      if (!pendingIdsRef.current.has(resource.taskId) && noticeRef.current?.taskId !== resource.taskId) return;
      deniedTaskIds.current.add(resource.taskId);
      if (noticeRef.current?.taskId === resource.taskId) {
        noticeRef.current = null;
        setNotice(null);
      }
    });
    return unsubscribe;
  }, [client]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      if (noticeRef.current === notice) {
        noticeRef.current = null;
        setNotice(null);
      }
    }, Math.max(0, notice.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => () => {
    for (const { timer } of inlineTimers.current.values()) clearTimeout(timer);
    inlineTimers.current.clear();
  }, []);
  return (
    <>
      <InlineCompletionContext.Provider value={inlineAcknowledgements}>
        <CompletionFeedbackOwnerProvider owner={owner}>
          <TaskCommandEligibilityProvider scope={commandEligibility}>
            {children}
          </TaskCommandEligibilityProvider>
        </CompletionFeedbackOwnerProvider>
      </InlineCompletionContext.Provider>
      {createPortal(
        <div role="status" aria-live="polite" aria-atomic="true"
          className={notice ? "view-completion-notice card" : "visually-hidden"}>
          {notice ? <span key={notice.sequence}>
            {notice.action === "complete"
              ? notice.recurring
                ? strings.taskOccurrenceConfirmed(notice.title)
                : strings.taskCompletionConfirmed(notice.title)
              : ({
                cancel: strings.taskCancellationConfirmed,
                reopen: strings.taskReopeningConfirmed,
                captured: strings.taskCaptureConfirmed,
                actionable: strings.taskActionableConfirmed,
                someday: strings.taskSomedayConfirmed,
              } as const)[notice.action](notice.title)}
          </span> : null}
        </div>,
        document.body,
      )}
    </>
  );
}
