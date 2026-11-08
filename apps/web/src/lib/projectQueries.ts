import { QueryClient } from "@tanstack/react-query";
import type { ProjectDetail, ProjectRevisionSnapshot, ProjectWithActions } from "./api";
import { isWorkItemAccessError, ProjectReadRevisionRegressionError } from "./errorMessage";

export const projectQueryKeys = {
  identity: (identity: string) => ["projects", identity] as const,
  detail: (identity: string, id: number) => ["projects", identity, "detail", id] as const,
};

export interface ProjectReadToken {
  id: number;
  identity: string;
  query: object;
  epoch: number;
}

export interface ProjectRead<T> {
  read: ProjectReadToken;
  value: T;
}

export function projectRevisionIsPublishable(
  current: { revision: number } | undefined,
  incoming: { revision: number },
) {
  return !current || current.revision <= incoming.revision;
}

export function projectStructuralSharing<T>(current: T | undefined, incoming: T): T {
  const previous = current as ({ revision: number } & object) | undefined;
  const next = incoming as ({ revision: number } & object);
  if (previous && !projectRevisionIsPublishable(previous, next)) {
    throw new ProjectReadRevisionRegressionError();
  }
  return incoming;
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}

export function isProjectDetail(value: ProjectWithActions): value is ProjectDetail {
  return "tasks" in value && Array.isArray(value.tasks);
}

export function reconcileProjectMetadata(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  result: ProjectWithActions | ProjectRevisionSnapshot,
) {
  queryClient.setQueryData<ProjectWithActions>(queryKey, current => {
    if (current && !projectRevisionIsPublishable(current, result)) return current;
    if (!current) return "availableActions" in result ? result : undefined;
    if (!isProjectDetail(current)) return { ...current, ...result };
    const merged = { ...current, ...result };
    if (current.revision < result.revision) {
      delete merged.activationDecisionSnapshot;
      delete merged.directActivationDecisionSnapshot;
    }
    return merged;
  });
}

export function projectReadIsAccessible(queryClient: QueryClient, identity: string, id: number) {
  const query = queryClient.getQueryCache().find({
    queryKey: projectQueryKeys.detail(identity, id),
    exact: true,
  });
  return !query || (query.meta?.readDenied !== true && !isWorkItemAccessError(query.state.error));
}

export function captureProjectRead(queryClient: QueryClient, identity: string, id: number): ProjectReadToken {
  const query = queryClient.getQueryCache().build(queryClient, {
    queryKey: projectQueryKeys.detail(identity, id),
    meta: { readEpoch: 0, readDenied: false },
    gcTime: Infinity,
    structuralSharing: projectStructuralSharing,
  });
  return {
    id,
    identity,
    query,
    epoch: typeof query.meta?.readEpoch === "number" ? query.meta.readEpoch : 0,
  };
}

export function projectReadIsCurrent(queryClient: QueryClient, read: ProjectReadToken) {
  const query = queryClient.getQueryCache().find({
    queryKey: projectQueryKeys.detail(read.identity, read.id),
    exact: true,
  });
  return query === read.query &&
    (typeof query.meta?.readEpoch === "number" ? query.meta.readEpoch : 0) === read.epoch;
}

export function setProjectReadState(queryClient: QueryClient, read: ProjectReadToken, denied: boolean) {
  if (!projectReadIsCurrent(queryClient, read)) return;
  const query = queryClient.getQueryCache().find({
    queryKey: projectQueryKeys.detail(read.identity, read.id),
    exact: true,
  });
  if (!query) return;
  const meta = query.meta ?? {};
  meta.readEpoch = read.epoch + (denied ? 1 : 0);
  meta.readDenied = denied;
  query.setOptions({ ...query.options, meta });
}
