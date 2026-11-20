import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isReadAccessError } from "./errorMessage";
import type { ReadAccessResource } from "./useAsync";
import { useTaskActions, type TaskCommandEligibility } from "./useTaskActions";

function sameResource(left: ReadAccessResource | undefined, right: ReadAccessResource) {
  if (!left || left.type !== right.type) return false;
  if (left.type === "task" && right.type === "task") return left.taskId === right.taskId;
  if (left.type === "waiting" && right.type === "waiting") {
    return left.memberId === right.memberId && left.scope === right.scope;
  }
  return left.type === "view" && right.type === "view" && left.key === right.key;
}

export function useViewTaskCommandEligibility({
  accessResource,
  enabled,
  readUnavailable,
}: {
  accessResource: ReadAccessResource;
  enabled: boolean;
  readUnavailable: boolean;
}): {
  scope: TaskCommandEligibility;
  accessGeneration: number;
  accessAvailable: boolean;
} {
  const client = useQueryClient();
  const { pendingTask, retirePendingDecisions } = useTaskActions();
  const [accessGeneration, setAccessGeneration] = useState(0);
  const [accessAvailable, setAccessAvailable] = useState(true);
  const [capabilityVersion, setCapabilityVersion] = useState(0);
  const accessAvailableRef = useRef(true);
  const successfulReadAfterAccessLoss = useRef(false);
  const pendingTaskRef = useRef(pendingTask);
  const scope = useMemo<TaskCommandEligibility>(
    () => ({
      id: Symbol("view-command"),
      active: enabled && !readUnavailable && accessAvailable,
    }),
    [accessAvailable, accessGeneration, accessResource],
  );
  const capability = useMemo<TaskCommandEligibility>(() => ({
    id: scope.id,
    get active() {
      return scope.active;
    },
    set active(value: boolean) {
      scope.active = value;
    },
  }), [capabilityVersion, scope]);
  const previousResource = useRef(accessResource);
  const previousScope = useRef(scope);
  pendingTaskRef.current = pendingTask;
  const setScopeActive = useCallback((active: boolean) => {
    if (scope.active === active) return;
    scope.active = active;
    setCapabilityVersion(version => version + 1);
  }, [scope]);

  useLayoutEffect(() => {
    if (previousResource.current !== accessResource) {
      previousScope.current.active = false;
      retirePendingDecisions(previousScope.current);
      previousResource.current = accessResource;
      accessAvailableRef.current = true;
      successfulReadAfterAccessLoss.current = false;
      setAccessAvailable(true);
    }
    if (previousScope.current !== scope) {
      previousScope.current.active = false;
      retirePendingDecisions(previousScope.current);
    }
    previousScope.current = scope;
  }, [accessResource, retirePendingDecisions, scope]);

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
        setScopeActive(false);
        retirePendingDecisions(scope);
        accessAvailableRef.current = false;
        successfulReadAfterAccessLoss.current = false;
        setAccessAvailable(false);
        setAccessGeneration(generation => generation + 1);
        return;
      }
      if (!isReadAccessError(event.query.state.error) || resource?.type !== "task") return;
      if (pendingTaskRef.current?.id === resource.taskId) {
        retirePendingDecisions(scope, resource.taskId);
      }
    });
    return unsubscribe;
  }, [accessResource, client, retirePendingDecisions, scope, setScopeActive]);

  useLayoutEffect(() => {
    if (!readUnavailable && !accessAvailableRef.current &&
      successfulReadAfterAccessLoss.current) {
      accessAvailableRef.current = true;
      successfulReadAfterAccessLoss.current = false;
      setAccessAvailable(true);
      setAccessGeneration(generation => generation + 1);
      setScopeActive(false);
      retirePendingDecisions(scope);
      return;
    }
    setScopeActive(enabled && !readUnavailable && accessAvailableRef.current);
    if (!scope.active) retirePendingDecisions(scope);
  }, [enabled, readUnavailable, retirePendingDecisions, scope, setScopeActive]);

  return { scope: capability, accessGeneration, accessAvailable };
}
