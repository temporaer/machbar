import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  CompletionFeedbackOwnerProvider,
  useTaskActions,
  type CompletionFeedbackOwner,
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
  children,
}: {
  accessResource: ReadAccessResource;
  enabled?: boolean;
  children: ReactNode;
}) {
  const strings = useStrings();
  const client = useQueryClient();
  const { registerCompletionFeedback, pendingIds } = useTaskActions();
  const owner = useMemo<CompletionFeedbackOwner>(() => Symbol("view-completion"), [accessResource]);
  const [available, setAvailable] = useState(true);
  const availableRef = useRef(true);
  const [notice, setNotice] = useState<CompletionNotice | null>(null);
  const noticeRef = useRef(notice);
  const pendingIdsRef = useRef(pendingIds);
  const deniedTaskIds = useRef(new Set<number>());
  const previousResource = useRef(accessResource);
  noticeRef.current = notice;
  pendingIdsRef.current = pendingIds;
  if (!enabled) availableRef.current = false;
  useLayoutEffect(() => {
    if (previousResource.current === accessResource) return;
    previousResource.current = accessResource;
    deniedTaskIds.current.clear();
    noticeRef.current = null;
    setNotice(null);
  }, [accessResource]);
  useLayoutEffect(() => {
    if (!enabled) {
      availableRef.current = false;
      setAvailable(false);
      noticeRef.current = null;
      setNotice(null);
      return;
    }
    availableRef.current = true;
    setAvailable(true);
    const unregister = registerCompletionFeedback(owner, {
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
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type !== "updated" || !isReadAccessError(event.query.state.error)) return;
      const resource = event.query.meta?.accessResource as ReadAccessResource | undefined;
      if (sameResource(resource, accessResource)) {
        unregister();
        availableRef.current = false;
        setAvailable(false);
        noticeRef.current = null;
        setNotice(null);
        return;
      }
      if (resource?.type !== "task" ||
        (!pendingIdsRef.current.has(resource.taskId) && noticeRef.current?.taskId !== resource.taskId)) return;
      deniedTaskIds.current.add(resource.taskId);
      if (noticeRef.current?.taskId === resource.taskId) {
        noticeRef.current = null;
        setNotice(null);
      }
    });
    return () => { unsubscribe(); unregister(); };
  }, [accessResource, client, enabled, owner, registerCompletionFeedback, strings]);
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
        {children}
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
