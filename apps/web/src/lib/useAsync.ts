import { useCallback, useId } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useStrings } from "./strings";
import { localizedErrorMessage } from "./errorMessage";
import { invalidateReads } from "./queryClient";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refreshError: string | null;
  reload: () => void;
}

export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
): AsyncState<T> {
  const strings = useStrings();
  const client = useQueryClient();
  const readId = useId();
  const query = useQuery({
    queryKey: ["read", readId, ...deps],
    queryFn: async ({ signal }) => {
      const result = await fetcher();
      signal.throwIfAborted();
      return result;
    },
  });
  const hasData = query.data !== undefined;
  const message = query.error === null ? null : localizedErrorMessage(query.error, strings);
  const queryObject = client.getQueryCache().find({ queryKey: ["read", readId, ...deps], exact: true });
  const reload = useCallback(() => {
    if (!queryObject) return;
    void invalidateReads(client, false, queryObject);
  }, [client, queryObject]);

  return {
    data: hasData ? query.data! : null,
    loading: !hasData && query.isPending,
    refreshing: hasData && query.isFetching,
    error: hasData ? null : message,
    refreshError: hasData ? message : null,
    reload,
  };
}
