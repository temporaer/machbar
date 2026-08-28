import { useState } from "react";
import type { SearchFilters } from "@machbar/shared";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { TaskOutline } from "../components/TaskOutline";
import { SearchFilterBar } from "../components/SearchFilterBar";

export function SearchPage() {
  const strings = useStrings();
  const [filters, setFilters] = useState<SearchFilters>({});
  const { data: projects } = useAsync(() => api.getProjects(), []);
  const { data: tags } = useAsync(() => api.getTags(), []);
  const {
    data: results,
    loading,
    error,
    reload,
  } = useAsync(() => api.searchTasks(filters), [JSON.stringify(filters)]);

  return (
    <div>
      <div className="page-header">
        <h1>{strings.search}</h1>
      </div>
      <SearchFilterBar filters={filters} onChange={setFilters} projects={projects ?? []} tags={tags ?? []} />
      <div className="section" style={{ marginTop: 16 }}>
        {loading ? <LoadingState /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {results ? (
          results.length === 0 ? (
            <EmptyState message={strings.searchEmpty} />
          ) : (
            <TaskOutline tasks={results} emptyMessage={strings.searchEmpty} />
          )
        ) : null}
      </div>
    </div>
  );
}
