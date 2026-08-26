import { useState } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRefresh } from "../lib/refresh";
import { strings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { useProjectWorkflowActions } from "../lib/useProjectWorkflowActions";
import {
  filterAndSortProjects,
  isTerminalProjectStatus,
  type ProjectVisibilityScope,
} from "../lib/projectListFilter";
import {
  groupItemsByTagKind,
  type GroupableTagKind,
} from "../lib/tagGrouping";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { ProjectStoryRow } from "../components/ProjectStoryRow";
import { BottomSheet } from "../components/BottomSheet";
import { TagGroupingControl } from "../components/TagGroupingControl";
import { CollapsibleGroup } from "../components/CollapsibleGroup";
import { PageHeader } from "../components/PageHeader";

/**
 * The Projekte tab: every project is a user story, and every row carries the
 * full Scrum-style workflow directly — right swipe (or the dedicated primary
 * button) performs the status-appropriate next step, left swipe or ⋯ reveals
 * the driver/criteria/dates/edit chips plus the remaining legal transitions.
 * See `components/ProjectStoryRow.tsx` for the gesture behaviour and
 * `lib/useProjectWorkflowActions.ts` for the optimistic retention.
 */
export function ProjectsPage() {
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
  // must never appear twice alongside its refetched counterpart.
  const retainedOnly = [...actions.retained.values()]
    .map((entry) => entry.story)
    .filter((story) => !listed.some((p) => p.id === story.id));
  const allProjects = [...listed, ...retainedOnly];

  const filteredProjects = filterAndSortProjects(allProjects, {
    query,
    scope,
    currentMemberId,
  });
  // Active/backlog stories stay primary and always visible; completed and
  // archived ones are terminal — they no longer need day-to-day attention,
  // so they fold into one counted section below instead of crowding the
  // primary list. `filteredProjects` is already sorted, so both slices keep
  // that same relative order. A story mid-transition is judged by its
  // optimistic (retained) status rather than the last-fetched one, so e.g.
  // reopening a completed story moves it back to the primary list right
  // away instead of leaving it stranded in the terminal fold until the next
  // reload — matching what `ProjectStoryRow` already renders for it.
  const effectiveStatusOf = (p: (typeof filteredProjects)[number]) => actions.retained.get(p.id)?.story ?? p;
  const primaryProjects = filteredProjects.filter((p) => !isTerminalProjectStatus(effectiveStatusOf(p)));
  const terminalProjects = filteredProjects.filter((p) => isTerminalProjectStatus(effectiveStatusOf(p)));
  const primaryGroups = groupBy
    ? groupItemsByTagKind(primaryProjects, groupBy)
    : primaryProjects.length > 0
      ? [{ tag: null, items: primaryProjects }]
      : [];
  const terminalGroups = groupBy
    ? groupItemsByTagKind(terminalProjects, groupBy)
    : terminalProjects.length > 0
      ? [{ tag: null, items: terminalProjects }]
      : [];
  // A non-empty search that actually matches a terminal story should reveal
  // it automatically instead of hiding a real match behind a fold; with no
  // search (or no terminal matches) the section stays folded by default.
  const revealTerminalProjects = query.trim() !== "" && terminalProjects.length > 0;

  return (
    <div>
      <PageHeader
        title={strings.projects}
        actions={(
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
            {strings.addProject}
          </button>
        )}
        hints={[{ text: strings.projectsSwipeHint }]}
      />
      <div className="stack">
        <input
          aria-label={strings.search}
          placeholder={strings.projectSearchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="list-option-group" role="group" aria-label={strings.filters}>
          <button
            type="button"
            className="list-option-button"
            aria-pressed={scope === "mine"}
            onClick={() => setScope("mine")}
          >
            {strings.projectScopeMineOpen}
          </button>
          <button
            type="button"
            className="list-option-button"
            aria-pressed={scope === "all"}
            onClick={() => setScope("all")}
          >
            {strings.projectScopeAll}
          </button>
        </div>
        <TagGroupingControl value={groupBy} onChange={setGroupBy} />
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
            {primaryGroups.map((group) => (
              groupBy ? (
                <CollapsibleGroup
                  key={`${groupBy}-${group.tag?.id ?? "none"}`}
                  title={group.tag?.name ?? strings.withoutTagKindLabels[groupBy]}
                  headingLevel={2}
                >
                  <ul className="list story-row-list">
                    {group.items.map((p) => (
                      <ProjectStoryRow key={p.id} story={p} actions={actions} variant="card" />
                    ))}
                  </ul>
                </CollapsibleGroup>
              ) : (
              <section className="section" key="all">
                <ul className="list story-row-list">
                  {group.items.map((p) => (
                    <ProjectStoryRow key={p.id} story={p} actions={actions} variant="card" />
                  ))}
                </ul>
              </section>
              )
            ))}
            {terminalProjects.length > 0 ? (
              <details className="section" open={revealTerminalProjects}>
                <summary className="section-title">
                  {strings.finishedProjectsSection(terminalProjects.length)}
                </summary>
                {terminalGroups.map((group) => (
                  groupBy ? (
                    <CollapsibleGroup
                      key={`${groupBy}-${group.tag?.id ?? "none"}`}
                      title={group.tag?.name ?? strings.withoutTagKindLabels[groupBy]}
                      headingLevel={3}
                    >
                      <ul className="list story-row-list">
                        {group.items.map((p) => (
                          <ProjectStoryRow key={p.id} story={p} actions={actions} variant="card" />
                        ))}
                      </ul>
                    </CollapsibleGroup>
                  ) : (
                  <section key="all">
                    <ul className="list story-row-list">
                      {group.items.map((p) => (
                        <ProjectStoryRow key={p.id} story={p} actions={actions} variant="card" />
                      ))}
                    </ul>
                  </section>
                  )
                ))}
              </details>
            ) : null}
          </>
        )
      ) : null}
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
