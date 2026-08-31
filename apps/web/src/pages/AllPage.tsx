import { useMemo, useState } from "react";
import type { SearchFilters } from "@machbar/shared";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useProjectActions } from "../lib/useProjectActions";
import { useStrings } from "../lib/strings";
import {
  filterInventoryProjects,
  hasInventoryFilters,
  topLevelTaskResults,
} from "../lib/allInventory";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { PageHeader } from "../components/PageHeader";
import { ProjectStoryRow } from "../components/ProjectStoryRow";
import { SearchFilterBar } from "../components/SearchFilterBar";
import { TaskOutline } from "../components/TaskOutline";
import { filterAndSortProjects } from "../lib/projectListFilter";
import { useLocale } from "../lib/locale";
import { sortInventoryTasks } from "../lib/sortOrder";

export function AllPage() {
  const strings = useStrings();
  const { locale } = useLocale();
  const [filters, setFilters] = useState<SearchFilters>({});
  const filtersKey = JSON.stringify(filters);
  const { data: projects, loading: projectsLoading, error: projectsError, reload: reloadProjects } =
    useAsync(() => api.getProjects(), []);
  const { data: tags } = useAsync(() => api.getTags(), []);
  const {
    data: tasks,
    loading: tasksLoading,
    error: tasksError,
    reload: reloadTasks,
  } = useAsync(() => api.searchTasks(filters), [filtersKey]);
  const projectActions = useProjectActions(projects ?? []);
  const filteredProjects = useMemo(
    () =>
      filterAndSortProjects(filterInventoryProjects(projects ?? [], filters), {
        query: "",
        scope: "all",
        currentMemberId: null,
        locale,
      }),
    [filtersKey, locale, projects],
  );
  const filtering = hasInventoryFilters(filters);
  const visibleTasks = sortInventoryTasks(
    filtering
      ? topLevelTaskResults(tasks ?? [])
      : (tasks ?? []).filter(
          (task) => task.projectId === null && task.parentTaskId === null,
        ),
    filters.text ?? "",
    locale,
  );
  const loading = projectsLoading || tasksLoading;
  const error = projectsError ?? tasksError;

  return (
    <div>
      <PageHeader title={strings.allTitle} hints={[{ text: strings.allHint }]} />
      <SearchFilterBar
        filters={filters}
        onChange={setFilters}
        projects={projects ?? []}
        tags={tags ?? []}
      />
      {loading ? <LoadingState /> : null}
      {error ? (
        <ErrorState
          message={error}
          onRetry={() => {
            reloadProjects();
            reloadTasks();
          }}
        />
      ) : null}
      {projects && tasks ? (
        filteredProjects.length === 0 && visibleTasks.length === 0 ? (
          <EmptyState message={strings.allEmpty} />
        ) : (
          <>
            {filteredProjects.length > 0 ? (
              <section className="section" aria-labelledby="all-projects-heading">
                <h2 id="all-projects-heading" className="section-title">
                  {strings.allProjectsHeading}
                </h2>
                <ul className="list story-row-list">
                  {filteredProjects.map((project) => (
                    <ProjectStoryRow
                      key={project.id}
                      story={project}
                      actions={projectActions}
                      variant="compact"
                    />
                  ))}
                </ul>
              </section>
            ) : null}
            {visibleTasks.length > 0 ? (
              <section className="section" aria-labelledby="all-tasks-heading">
                <h2 id="all-tasks-heading" className="section-title">
                  {filtering ? strings.allMatchingTasksHeading : strings.allStandaloneTasksHeading}
                </h2>
                <TaskOutline
                  tasks={visibleTasks}
                  emptyMessage={strings.allEmpty}
                  preserveRootOrder
                />
              </section>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
