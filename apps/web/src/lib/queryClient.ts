import { QueryCache, QueryClient, type Query, type QueryFilters } from "@tanstack/react-query";
import { isReadAccessError } from "./errorMessage";

export function createReadQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (isReadAccessError(error)) {
          query.setState({ data: undefined });
        }
      },
    }),
    defaultOptions: {
      queries: {
        retry: false,
        networkMode: "always",
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        gcTime: 0,
      },
    },
  });
}

export async function invalidateReads(client: QueryClient, afterWrite = false, only?: Query) {
  const filter: QueryFilters = only ? { predicate: query => query === only } : {};
  if (afterWrite) {
    await client.cancelQueries(filter);
    await client.invalidateQueries(filter);
    return;
  }
  const fetching = client.getQueryCache().findAll({ ...filter, type: "active", fetchStatus: "fetching" });
  await Promise.all([
    client.invalidateQueries(filter, { cancelRefetch: false }),
    ...fetching.map(async (query) => {
      const filter = { type: "active" as const, predicate: (candidate: typeof query) => candidate === query };
      await client.refetchQueries(filter, { cancelRefetch: false });
      await client.refetchQueries(filter, { cancelRefetch: false });
    }),
  ]);
}
