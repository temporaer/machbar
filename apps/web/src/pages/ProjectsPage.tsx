import { useRef, useState } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { useProjectWorkflowActions } from "../lib/useProjectWorkflowActions";
import {
  classifyProjectListItem,
  filterAndSortProjects,
  type ProjectVisibilityScope,
} from "../lib/projectListFilter";
import {
  groupItemsByTagKind,
  type GroupableTagKind,
} from "../lib/tagGrouping";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { ProjectStoryRow } from "../components/ProjectStoryRow";
import { BottomSheet } from "../components/BottomSheet";
import { TagGroupingOptions } from "../components/TagGroupingControl";
import { ListOptionDisclosureTrigger } from "../components/ListOptionDisclosure";
import { CollapsibleGroup } from "../components/CollapsibleGroup";
import { PageHeader } from "../components/PageHeader";
import { useLocale } from "../lib/locale";

/**
 * The Projekte tab: every project is a user story, and every row carries the
 * full Scrum-style workflow directly — right swipe (or the dedicated primary
 * button on larger screens) performs the status-appropriate next step, while
 * left swipe or ⋯ reveals the targeted chips plus the remaining legal
 * transitions.
 * See `components/ProjectStoryRow.tsx` for the gesture behaviour and
 * `lib/useProjectWorkflowActions.ts` for the optimistic retention.
 */
export function ProjectsPage() {
  const strings = useStrings();
  const { locale } = useLocale();
  const { data: projects, loading, error, reload } = useAsync(() => api.getProjects(), []);
  const { bump } = useRefresh();
  const { currentMemberId } = useIdentity();
  const actions = useProjectWorkflowActions();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ProjectVisibilityScope>("mine");
  const [groupBy, setGroupBy] = useState<GroupableTagKind | null>(null);
  const [openViewControl, setOpenViewControl] = useState<"filter" | "grouping" | null>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const groupingTriggerRef = useRef<HTMLButtonElement>(null);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await api.createProject({ title: trimmed });
      setTitle("");
      setCreating(false);
      bump();
      reload();
    } finally {
      setSaving(false);
    }
  };

  const listed = projects ?? [];
  // A story that just transitioned optimistically must keep rendering during
  // its retention window even if a refetch drops it from this list — but,
  // just like every other row, it still obeys the current search/scope and
  // must never appear twice alongside its refetched counterpart. When both
  // copies exist, the retained story is the effective one for filtering and
  // section placement as well as for the row itself.
  const retainedOnly = [...actions.retained.values()]
    .map((entry) => entry.story)
    .filter((story) => !listed.some((p) => p.id === story.id));
  const allProjects = [
    ...listed.map((project) => actions.retained.get(project.id)?.story ?? project),
    ...retainedOnly,
  ];

  const filteredProjects = filterAndSortProjects(allProjects, {
    query,
    scope,
    currentMemberId,
    locale,
  });
  // Keep workflow meaning ahead of tag grouping: actionable and stuck work
  // stays first, healthy waiting gets its own visible section, backlog comes
  // after it, and terminal work remains folded at the bottom.
  const classifications = new Map(
    filteredProjects.map((project) => [project.id, classifyProjectListItem(project)]),
  );
  const activeProjects = filteredProjects.filter((project) => {
    const classification = classifications.get(project.id);
    return classification === "active-actionable" || classification === "active-stuck";
  });
  const waitingProjects = filteredProjects.filter(
    (project) => classifications.get(project.id) === "healthy-waiting",
  );
  const backlogProjects = filteredProjects.filter(
    (project) => classifications.get(project.id) === "backlog",
  );
  const terminalProjects = filteredProjects.filter((project) => {
    const classification = classifications.get(project.id);
    return classification === "completed" || classification === "archived";
  });
  const groupsFor = (items: typeof filteredProjects) =>
    groupBy
      ? groupItemsByTagKind(items, groupBy, locale)
      : items.length > 0
        ? [{ tag: null, items }]
        : [];
  const renderGroups = (
    sectionKey: string,
    items: typeof filteredProjects,
    headingLevel: 2 | 3,
  ) =>
    groupsFor(items).map((group) =>
      groupBy ? (
        <CollapsibleGroup
          key={`${sectionKey}-${groupBy}-${group.tag?.id ?? "none"}`}
          title={group.tag?.name ?? strings.withoutTagKindLabels[groupBy]}
          headingLevel={headingLevel}
        >
          <ul className="list story-row-list">
            {group.items.map((project) => (
              <ProjectStoryRow key={project.id} story={project} actions={actions} variant="card" />
            ))}
          </ul>
        </CollapsibleGroup>
      ) : (
        <ul className="list story-row-list" key={`${sectionKey}-all`}>
          {group.items.map((project) => (
            <ProjectStoryRow key={project.id} story={project} actions={actions} variant="card" />
          ))}
        </ul>
      ),
    );
  // A non-empty search that actually matches a terminal story should reveal
  // it automatically instead of hiding a real match behind a fold; with no
  // search (or no terminal matches) the section stays folded by default.
  const revealTerminalProjects = query.trim() !== "" && terminalProjects.length > 0;

  return (
    <div className="projects-page">
      <PageHeader
        title={strings.projects}
        hints={[{ text: strings.projectsSwipeHint }]}
      />
      <div className="stack projects-controls">
        <input
          aria-label={strings.search}
          placeholder={strings.projectSearchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="project-list-options">
          <ListOptionDisclosureTrigger
            label={strings.filters}
            value={scope === "mine" ? strings.projectScopeMineOpen : strings.projectScopeAll}
            expanded={openViewControl === "filter"}
            controls="project-filter-options"
            onClick={() =>
              setOpenViewControl((current) => (current === "filter" ? null : "filter"))
            }
            buttonRef={filterTriggerRef}
          />
          <ListOptionDisclosureTrigger
            label={strings.grouping}
            value={groupBy ? strings.tagKindLabels[groupBy] : strings.noGrouping}
            expanded={openViewControl === "grouping"}
            controls="project-grouping-options"
            onClick={() =>
              setOpenViewControl((current) => (current === "grouping" ? null : "grouping"))
            }
            buttonRef={groupingTriggerRef}
          />
          <div className="project-list-options-panel" hidden={openViewControl === null}>
            <div
              id="project-filter-options"
              className="list-option-group"
              role="group"
              aria-label={strings.filters}
              hidden={openViewControl !== "filter"}
            >
              <button
                type="button"
                className="list-option-button"
                aria-pressed={scope === "mine"}
                onClick={() => {
                  setScope("mine");
                  setOpenViewControl(null);
                  filterTriggerRef.current?.focus();
                }}
              >
                {strings.projectScopeMineOpen}
              </button>
              <button
                type="button"
                className="list-option-button"
                aria-pressed={scope === "all"}
                onClick={() => {
                  setScope("all");
                  setOpenViewControl(null);
                  filterTriggerRef.current?.focus();
                }}
              >
                {strings.projectScopeAll}
              </button>
            </div>
            <TagGroupingOptions
              id="project-grouping-options"
              value={groupBy}
              hidden={openViewControl !== "grouping"}
              onChange={(nextValue) => {
                setGroupBy(nextValue);
                setOpenViewControl(null);
                groupingTriggerRef.current?.focus();
              }}
            />
          </div>
        </div>
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {projects ? (
        allProjects.length === 0 ? (
          <EmptyState message={strings.noProjects} />
        ) : filteredProjects.length === 0 ? (
          <EmptyState message={strings.noMatchingProjects} />
        ) : (
          <>
            {activeProjects.length > 0 ? (
              <section
                className="section"
                data-project-section="active"
                aria-label={strings.activeProjectsSection}
              >
                {renderGroups("active", activeProjects, 2)}
              </section>
            ) : null}
            {waitingProjects.length > 0 ? (
              <section
                className="section"
                data-project-section="waiting"
                aria-labelledby="waiting-projects-heading"
              >
                <h2 className="section-title" id="waiting-projects-heading">
                  {strings.waitingProjectsSection(waitingProjects.length)}
                </h2>
                {renderGroups("waiting", waitingProjects, 3)}
              </section>
            ) : null}
            {backlogProjects.length > 0 ? (
              <section
                className="section"
                data-project-section="backlog"
                aria-label={strings.backlogProjectsSection}
              >
                {renderGroups("backlog", backlogProjects, 2)}
              </section>
            ) : null}
            {terminalProjects.length > 0 ? (
              <details
                className="section"
                data-project-section="terminal"
                open={revealTerminalProjects}
              >
                <summary className="section-title disclosure-summary">
                  {strings.finishedProjectsSection(terminalProjects.length)}
                </summary>
                {renderGroups("terminal", terminalProjects, 3)}
              </details>
            ) : null}
          </>
        )
      ) : null}
      <button
        type="button"
        className="quick-add-fab"
        aria-label={strings.addProject}
        onClick={() => setCreating(true)}
      >
        +
      </button>
      {creating ? (
        <BottomSheet title={strings.newProject} onClose={() => setCreating(false)} labelledBy="new-project-title">
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="field">
              <label htmlFor="new-project-name">{strings.projectTitle}</label>
              <input id="new-project-name" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <p className="text-muted">{strings.titleEnough}</p>
            <div className="row">
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                {strings.cancel}
              </button>
              <button type="submit" className="btn btn-primary btn-block" disabled={saving || !title.trim()}>
                {strings.save}
              </button>
            </div>
          </form>
        </BottomSheet>
      ) : null}
    </div>
  );
}
