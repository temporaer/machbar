import { useMemo, useState } from "react";
import type { SearchFilters, Task } from "@machbar/shared";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useStrings } from "../lib/strings";
import {
  filterInventoryProjects,
  hasInventoryFilters,
  topLevelTaskResults,
} from "../lib/allInventory";
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from "../components/AsyncStates";
import { PageHeader } from "../components/PageHeader";
import { ProjectStoryRow } from "../components/ProjectStoryRow";
import { SearchFilterBar } from "../components/SearchFilterBar";
import { TaskOutline } from "../components/TaskOutline";
import { filterAndSortProjects } from "../lib/projectListFilter";
import { useLocale } from "../lib/locale";
import { sortInventoryTasks } from "../lib/sortOrder";
import { recencyRankLookup } from "../lib/recentlyViewed";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { WorkItemKeyboardNavMount } from "../components/WorkItemKeyboardNavMount";
import { MaterialCard } from "../components/MaterialCard";
import { parseReferenceContent } from "../lib/referenceContent";

function MaterialResults({ tasks }: { tasks: Task[] }) {
  const hasPaperlessAttachments = tasks.some(
    (task) => parseReferenceContent(task.notes).paperlessAttachments.length > 0,
  );
  const { data: paperlessStatus } = useAsync(
    () =>
      hasPaperlessAttachments && typeof api.getPaperlessStatus === "function"
        ? api.getPaperlessStatus()
        : Promise.resolve(null),
    [hasPaperlessAttachments],
  );

  return (
    <div className="material-card-list">
      {tasks.map((task) => (
        <MaterialCard
          key={task.id}
          task={task}
          context={task.projectTitle ?? undefined}
          paperlessUiBaseUrl={paperlessStatus?.documentUiBaseUrl ?? null}
          keyboardNavigable
        />
      ))}
    </div>
  );
}

export function AllPage() {
  const strings = useStrings();
  const { locale } = useLocale();
  const [filters, setFilters] = useState<SearchFilters>({});
  const filtersKey = JSON.stringify(filters);
  const {
    data: projects,
    loading: projectsLoading,
    error: projectsError,
    reload: reloadProjects,
  } = useAsync(() => api.getProjects(), []);
  const { data: tags } = useAsync(() => api.getTags(), []);
  const {
    data: tasks,
    loading: tasksLoading,
    error: tasksError,
    reload: reloadTasks,
  } = useAsync(() => api.searchTasks({ ...filters, includeTerminal: true }), [filtersKey]);
  const projectCandidates = useMemo(
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
  const materialOnly = filters.kinds?.includes("reference") ?? false;
  const taskCandidates = sortInventoryTasks(
    filtering
      ? materialOnly
        ? tasks ?? []
        : topLevelTaskResults(tasks ?? [])
      : (tasks ?? []).filter(
          (task) => task.projectId === null && task.parentTaskId === null,
        ),
    filters.text ?? "",
    locale,
    { recencyRank: recencyRankLookup("task") },
  );
  const visibleTasks = taskCandidates;
  const filteredProjects = materialOnly ? [] : projectCandidates;
  const loading = projectsLoading || tasksLoading;
  const error = projectsError ?? tasksError;

  return (
    <InteractionScopeProvider>
      <WorkItemKeyboardNavMount />
      <div>
        <PageHeader
          title={strings.allTitle}
        />
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
            <EmptyState message={materialOnly ? strings.allMaterialEmpty : strings.allEmpty} />
          ) : (
            <>
              {filteredProjects.length > 0 ? (
                <section
                  className="section"
                  aria-labelledby="all-projects-heading"
                >
                  <h2 id="all-projects-heading" className="section-title">
                    {strings.allProjectsHeading}
                  </h2>
                  <ul className="list story-row-list">
                    {filteredProjects.map((project) => (
                      <ProjectStoryRow
                        key={project.id}
                        story={project}
                        variant="compact"
                      />
                    ))}
                  </ul>
                </section>
              ) : null}
              {visibleTasks.length > 0 ? (
                <section
                  className="section"
                  aria-labelledby={materialOnly ? "all-material-heading" : "all-tasks-heading"}
                >
                  <h2
                    id={materialOnly ? "all-material-heading" : "all-tasks-heading"}
                    className="section-title"
                  >
                    {materialOnly
                      ? strings.materialLabel
                      : filtering
                        ? strings.allMatchingTasksHeading
                        : strings.allStandaloneTasksHeading}
                  </h2>
                  {materialOnly ? (
                    <MaterialResults tasks={visibleTasks} />
                  ) : (
                    <TaskOutline
                      key={filtersKey}
                      tasks={visibleTasks}
                      emptyMessage={strings.allEmpty}
                      preserveRootOrder
                    />
                  )}
                </section>
              ) : null}
            </>
          )
        ) : null}
      </div>
    </InteractionScopeProvider>
  );
}
