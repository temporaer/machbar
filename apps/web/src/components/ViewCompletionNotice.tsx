import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
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

interface CompletionNotice {
  taskId: number;
  title: string;
  recurring: boolean;
  action: TaskFeedbackAction;
  expiresAt: number;
  sequence: number;
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
  const noticeRef = useRef(notice);
  const pendingIdsRef = useRef(pendingIds);
  const deniedTaskIds = useRef(new Set<number>());
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
  }, [accessResource]);
  useLayoutEffect(() => {
    if (previousAccessGeneration.current === accessGeneration) return;
    previousAccessGeneration.current = accessGeneration;
    deniedTaskIds.current.clear();
    noticeRef.current = null;
    setNotice(null);
  }, [accessGeneration]);
  useLayoutEffect(() => {
    if (!available) {
      noticeRef.current = null;
      setNotice(null);
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
    available,
    owner,
    registerCompletionFeedback,
    strings,
  ]);
  useLayoutEffect(() => {
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type !== "updated") return;
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
  return (
    <>
      <CompletionFeedbackOwnerProvider owner={owner}>
        <TaskCommandEligibilityProvider scope={commandEligibility}>
          {children}
        </TaskCommandEligibilityProvider>
      </CompletionFeedbackOwnerProvider>
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
