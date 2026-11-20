import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  CompletionFeedbackOwnerProvider,
  TaskCommandEligibilityProvider,
  useTaskActions,
  type CompletionFeedbackOwner,
  type TaskCommandEligibility,
} from "../lib/useTaskActions";
import { useStrings } from "../lib/strings";
import { isReadAccessError } from "../lib/errorMessage";
import type { ReadAccessResource } from "../lib/useAsync";

interface CompletionNotice {
  taskId: number;
  title: string;
  recurring: boolean;
  expiresAt: number;
  sequence: number;
}

function sameResource(left: ReadAccessResource | undefined, right: ReadAccessResource) {
  if (!left || left.type !== right.type) return false;
  if (left.type === "task" && right.type === "task") return left.taskId === right.taskId;
  if (left.type === "waiting" && right.type === "waiting") {
    return left.memberId === right.memberId && left.scope === right.scope;
  }
  return left.type === "view" && right.type === "view" && left.key === right.key;
}

export function ViewCompletionNotice({
  accessResource,
  enabled = true,
  readUnavailable = false,
  children,
}: {
  accessResource: ReadAccessResource;
  enabled?: boolean;
  readUnavailable?: boolean;
  children: ReactNode;
}) {
  const strings = useStrings();
  const client = useQueryClient();
  const { registerCompletionFeedback, pendingIds, pendingTask, retirePendingDecisions } = useTaskActions();
  const [accessGeneration, setAccessGeneration] = useState(0);
  const owner = useMemo<CompletionFeedbackOwner>(
    () => Symbol("view-completion"),
    [accessGeneration, accessResource],
  );
  const commandEligibility = useMemo<TaskCommandEligibility>(
    () => ({ id: Symbol("view-command"), active: false }),
    [accessGeneration, accessResource],
  );
  const [available, setAvailable] = useState(true);
  const availableRef = useRef(true);
  const accessAvailableRef = useRef(true);
  const successfulReadAfterAccessLoss = useRef(false);
  const [notice, setNotice] = useState<CompletionNotice | null>(null);
  const noticeRef = useRef(notice);
  const pendingIdsRef = useRef(pendingIds);
  const pendingTaskRef = useRef(pendingTask);
  const deniedTaskIds = useRef(new Set<number>());
  const previousResource = useRef(accessResource);
  const previousCommandEligibility = useRef(commandEligibility);
  noticeRef.current = notice;
  pendingIdsRef.current = pendingIds;
  pendingTaskRef.current = pendingTask;
  if (!enabled) availableRef.current = false;
  useLayoutEffect(() => {
    if (previousResource.current === accessResource) return;
    previousCommandEligibility.current.active = false;
    retirePendingDecisions(previousCommandEligibility.current);
    previousResource.current = accessResource;
    previousCommandEligibility.current = commandEligibility;
    accessAvailableRef.current = true;
    successfulReadAfterAccessLoss.current = false;
    deniedTaskIds.current.clear();
    noticeRef.current = null;
    setNotice(null);
  }, [accessResource, commandEligibility, retirePendingDecisions]);
  useLayoutEffect(() => {
    if (!enabled || !accessAvailableRef.current) {
      if (!enabled) {
        commandEligibility.active = false;
        retirePendingDecisions(commandEligibility);
        availableRef.current = false;
        setAvailable(false);
        noticeRef.current = null;
        setNotice(null);
      }
      return;
    }
    availableRef.current = true;
    setAvailable(true);
    return registerCompletionFeedback(owner, {
      pendingMessage: strings.taskCompleting,
      onCommitted: completion => {
        if (!availableRef.current || deniedTaskIds.current.has(completion.taskId)) return;
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
    enabled,
    owner,
    registerCompletionFeedback,
    retirePendingDecisions,
    strings.taskCompleting,
  ]);
  useLayoutEffect(() => {
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type !== "updated") return;
      const resource = event.query.meta?.accessResource as ReadAccessResource | undefined;
      if (sameResource(resource, accessResource)) {
        if (!isReadAccessError(event.query.state.error)) {
          if (!accessAvailableRef.current && event.query.state.status === "success") {
            successfulReadAfterAccessLoss.current = true;
          }
          return;
        }
        if (!accessAvailableRef.current) return;
        commandEligibility.active = false;
        retirePendingDecisions(commandEligibility);
        accessAvailableRef.current = false;
        successfulReadAfterAccessLoss.current = false;
        availableRef.current = false;
        setAvailable(false);
        noticeRef.current = null;
        setNotice(null);
        setAccessGeneration(generation => generation + 1);
        return;
      }
      if (!isReadAccessError(event.query.state.error) || resource?.type !== "task") return;
      if (pendingTaskRef.current?.id === resource.taskId) {
        retirePendingDecisions(commandEligibility, resource.taskId);
      }
      if (!pendingIdsRef.current.has(resource.taskId) && noticeRef.current?.taskId !== resource.taskId) return;
      deniedTaskIds.current.add(resource.taskId);
      if (noticeRef.current?.taskId === resource.taskId) {
        noticeRef.current = null;
        setNotice(null);
      }
    });
    return unsubscribe;
  }, [accessResource, client, commandEligibility, retirePendingDecisions]);
  useLayoutEffect(() => {
    if (!readUnavailable && !accessAvailableRef.current &&
      successfulReadAfterAccessLoss.current) {
      accessAvailableRef.current = true;
      successfulReadAfterAccessLoss.current = false;
      setAccessGeneration(generation => generation + 1);
    }
    commandEligibility.active = !readUnavailable && accessAvailableRef.current;
    if (!commandEligibility.active) {
      commandEligibility.active = false;
      retirePendingDecisions(commandEligibility);
    }
  }, [commandEligibility, enabled, readUnavailable, retirePendingDecisions]);
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
  return (
    <>
      <CompletionFeedbackOwnerProvider owner={enabled && available ? owner : null}>
        <TaskCommandEligibilityProvider scope={commandEligibility}>
          {children}
        </TaskCommandEligibilityProvider>
      </CompletionFeedbackOwnerProvider>
      {createPortal(
        <div role="status" aria-live="polite" aria-atomic="true"
          className={notice ? "view-completion-notice card" : "visually-hidden"}>
          {notice ? <span key={notice.sequence}>
            {notice.recurring
              ? strings.taskOccurrenceConfirmed(notice.title)
              : strings.taskCompletionConfirmed(notice.title)}
          </span> : null}
        </div>,
        document.body,
      )}
    </>
  );
}
