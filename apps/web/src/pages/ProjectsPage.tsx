import type { Tag } from "@machbar/shared";
import type { ProjectWithActions } from "../lib/api";
import { useRetainedPlacement } from "../lib/useRetainedPlacement";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { useIdentity } from "../lib/identity";
import { useProjectActions } from "../lib/useProjectActions";
import {
  classifyProjectListItem,
  countScopeHiddenMatches,
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
import { IconActionGlyph } from "../components/IconActionButton";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { nextAgendaScope, readTodayScope, writeTodayScope } from "../lib/todayScope";
import { useHomeAssistantStatus } from "../lib/useHomeAssistantStatus";

/**
 * The Projekte tab: current and terminal projects are user stories, and every
 * row carries the full Scrum-style workflow directly — right swipe (or the dedicated primary
 * button on larger screens) performs the status-appropriate next step, while
 * left swipe or ⋯ reveals the targeted chips plus the remaining legal
 * transitions.
 * See `components/ProjectStoryRow.tsx` for the gesture behaviour and
 * `lib/useProjectActions.ts` for the optimistic retention.
 */
export function ProjectsPage() {
  return (
    <InteractionScopeProvider>
      <ProjectsPageContent />
    </InteractionScopeProvider>
  );
}

function ProjectsPageContent() {
  const strings = useStrings();
  const { data: homeAssistant } = useHomeAssistantStatus();
  const { locale } = useLocale();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: projects, loading, error, reload } = useAsync(() => api.getProjects(), []);
  const { bump } = useRefresh();
  const { currentMemberId } = useIdentity();
  const actions = useProjectActions(projects ?? []);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ProjectVisibilityScope>(readTodayScope);
  const selectScope = (nextScope: ProjectVisibilityScope) => {
    setScope(nextScope);
    writeTodayScope(nextScope);
  };
  const [groupBy, setGroupBy] = useState<GroupableTagKind | null>(null);
  const [groupingOpen, setGroupingOpen] = useState(false);
  // A just-created project handed off via `navigate(..., { state: { highlightProjectId } })`
  // (e.g. right after converting an Inbox item to a backlog project) so its
  // section auto-expands and the row scrolls into view instead of the
  // project silently landing in a folded, invisible section. `pendingHighlightId`
  // is captured once and never cleared -- it keeps the backlog section open
  // for the rest of this page visit -- while `pulseActive` only drives the
  // temporary visual pulse on the row and is cleared after it plays.
  const [pendingHighlightId] = useState<number | null>(
    () => (location.state as { highlightProjectId?: number } | null)?.highlightProjectId ?? null,
  );
  const [pulseActive, setPulseActive] = useState(pendingHighlightId !== null);
  const groupingTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Consume the router-handoff state once so a later Back/Forward
    // navigation to this route doesn't re-trigger the highlight.
    if (pendingHighlightId === null) return;
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!pulseActive || pendingHighlightId === null || !projects) return;
    const row = document.querySelector<HTMLElement>(
      `[data-workitem-id="${pendingHighlightId}"]`,
    );
    if (!row) return;
    row.scrollIntoView?.({ block: "center", behavior: "smooth" });
    row.classList.add("project-row-highlight");
    const timeout = setTimeout(() => {
      row.classList.remove("project-row-highlight");
      setPulseActive(false);
    }, 2500);
    return () => clearTimeout(timeout);
  }, [pulseActive, pendingHighlightId, projects]);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await api.createProject({
        title: trimmed,
        ...(scope === "work" ? { scope: "work" } : {}),
      });
      setTitle("");
      setCreating(false);
      bump();
      reload();
    } finally {
      setSaving(false);
    }
  };

  const latestProject = (project: NonNullable<typeof projects>[number]) => {
    return actions.projectStory(project);
  };
  const allProjects = (projects ?? []).map(latestProject);

  const now = new Date();
  const filteredProjects = filterAndSortProjects(allProjects, {
    query,
    scope,
    currentMemberId,
    locale,
    now,
  });
  const hiddenMatchCount =
    scope === "mine"
      ? countScopeHiddenMatches(allProjects, query, currentMemberId)
      : 0;
  // Keep workflow meaning ahead of tag grouping: actionable, review, and
  // stuck work stays in the foreground; healthy waiting and deferred work
  // share one quiet folded section, and terminal work remains folded below.
  const classifications = new Map(
    filteredProjects.map((project) => [project.id, classifyProjectListItem(project, now)]),
  );
  const activeCandidates = filteredProjects.filter((project) => {
    const classification = classifications.get(project.id);
    return (
      classification === "active-actionable" ||
      classification === "active-review" ||
      classification === "active-stuck"
    );
  });
  const quietCandidates = filteredProjects.filter((project) => {
    const classification = classifications.get(project.id);
    return classification === "active-waiting" || classification === "active-deferred";
  });
  const backlogCandidates = filteredProjects.filter(
    (project) => classifications.get(project.id) === "backlog",
  );
  const terminalCandidates = filteredProjects.filter((project) => {
    const classification = classifications.get(project.id);
    return classification === "completed" || classification === "archived";
  });
  type Section = "active" | "quiet" | "backlog" | "terminal";
  type PlacementNode = { id: number | string; revision?: number; tag?: Tag | null; project?: ProjectWithActions; children?: PlacementNode[] };
  const groupCandidates = (section: Section, projects: ProjectWithActions[]): PlacementNode[] => {
    const groups = groupBy ? groupItemsByTagKind(projects, groupBy, locale) : projects.length ? [{ tag: null, items: projects }] : [];
    return groups.map(group => ({ id: `${section}:${groupBy ?? "all"}:${group.tag?.id ?? "none"}`, tag: group.tag,
      children: group.items.map(project => ({ id: project.id, revision: project.revision, project })) }));
  };
  const sections = useRetainedPlacement({
    active: groupCandidates("active", activeCandidates), quiet: groupCandidates("quiet", quietCandidates),
    backlog: groupCandidates("backlog", backlogCandidates), terminal: groupCandidates("terminal", terminalCandidates),
  }, node => node.project !== undefined && actions.holdingIds.has(node.project.id), node => {
    if (!node.project) return node;
    const project = latestProject(node.project);
    return { ...node, project, revision: project.revision };
  }, `${query}:${scope}:${currentMemberId}:${groupBy}`);
  const groupsFor = (section: Section) => sections[section].flatMap(node => {
    const items = (node.children ?? []).flatMap(child => child.project ? [child.project] : []);
    return items.length ? [{ tag: node.tag ?? null, items }] : [];
  });
  const projectsFor = (section: Section) => groupsFor(section).flatMap(group => group.items);
  const activeProjects = projectsFor("active");
  const quietProjects = projectsFor("quiet");
  const backlogProjects = projectsFor("backlog");
  const terminalProjects = projectsFor("terminal");
  const renderGroups = (
    sectionKey: Section,
    headingLevel: 2 | 3,
  ) =>
    groupsFor(sectionKey).map((group) =>
      groupBy ? (
        <CollapsibleGroup
          key={`${sectionKey}-${groupBy}-${group.tag?.id ?? "none"}`}
          title={group.tag?.name ?? strings.withoutTagKindLabels[groupBy]}
          headingLevel={headingLevel}
        >
          <ul className="list story-row-list">
            {group.items.map((project) => (
              <ProjectStoryRow
                key={project.id}
                story={project}
                variant={sectionKey === "quiet" ? "quiet" : "card"}
              />
            ))}
          </ul>
        </CollapsibleGroup>
      ) : (
        <ul className="list story-row-list" key={`${sectionKey}-all`}>
          {group.items.map((project) => (
            <ProjectStoryRow
              key={project.id}
              story={project}
              variant={sectionKey === "quiet" ? "quiet" : "card"}
            />
          ))}
        </ul>
      ),
    );
  // A non-empty search that actually matches a terminal story should reveal
  // it automatically instead of hiding a real match behind a fold; with no
  // search (or no terminal matches) the section stays folded by default.
  const revealTerminalProjects = query.trim() !== "" && terminalProjects.length > 0;
  const revealQuietProjects =
    (query.trim() !== "" && quietProjects.length > 0) ||
    (pendingHighlightId !== null &&
      quietProjects.some((project) => project.id === pendingHighlightId));
  const revealBacklogProjects =
    pendingHighlightId !== null &&
    backlogProjects.some((project) => project.id === pendingHighlightId);

  return (
    <div className="projects-page">
      <PageHeader
        title={strings.projects}
        actions={
          <>
            {homeAssistant?.intakeReady ? (
              <Link
                to="/more/cleanup-round"
                className="page-header-button cleanup-round-shortcut"
                aria-label={strings.cleanupRoundShortcutLabel}
                title={strings.cleanupRoundShortcutTitle}
              >
                <span aria-hidden="true">✨</span>
              </Link>
            ) : null}
            <button
              type="button"
              className="page-header-button projects-scope-toggle"
              aria-label={
                scope === "mine"
                  ? strings.projectHouseholdScope
                  : scope === "all"
                    ? strings.projectWorkScope
                    : strings.projectMineScope
              }
              aria-pressed={scope !== "mine"}
              title={
                scope === "mine"
                  ? strings.projectHouseholdScope
                  : scope === "all"
                    ? strings.projectWorkScope
                    : strings.projectMineScope
              }
              onClick={() => selectScope(nextAgendaScope(scope))}
            >
              <IconActionGlyph
                kind={scope === "mine" ? "owner" : scope === "all" ? "household" : "work"}
              />
            </button>
          </>
        }
      />
      <div className="stack projects-controls">
        <input
          aria-label={strings.search}
          placeholder={strings.projectSearchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {hiddenMatchCount > 0 ? (
          <div className="row">
            <p className="text-muted">{strings.projectHiddenMatchesHint(hiddenMatchCount)}</p>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setScope("all")}
            >
              {strings.showAllProjects}
            </button>
          </div>
        ) : null}
        <div className="project-list-options">
          <ListOptionDisclosureTrigger
            label={strings.grouping}
            value={groupBy ? strings.tagKindLabels[groupBy] : strings.noGrouping}
            expanded={groupingOpen}
            controls="project-grouping-options"
            onClick={() => setGroupingOpen((current) => !current)}
            buttonRef={groupingTriggerRef}
          />
          <div className="project-list-options-panel" hidden={!groupingOpen}>
            <TagGroupingOptions
              id="project-grouping-options"
              value={groupBy}
              hidden={!groupingOpen}
              onChange={(nextValue) => {
                setGroupBy(nextValue);
                setGroupingOpen(false);
                groupingTriggerRef.current?.focus();
              }}
            />
          </div>
        </div>
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {projects ? (
        allProjects.length === 0 && activeProjects.length + quietProjects.length + backlogProjects.length + terminalProjects.length === 0 ? (
          <EmptyState message={strings.noProjects} />
        ) : activeProjects.length + quietProjects.length + backlogProjects.length + terminalProjects.length === 0 ? (
          <EmptyState message={strings.noMatchingProjects} />
        ) : (
          <>
            {activeProjects.length > 0 ? (
              <section
                className="section"
                data-project-section="active"
                aria-label={strings.activeProjectsSection}
              >
                {renderGroups("active", 2)}
              </section>
            ) : null}
            {quietProjects.length > 0 ? (
              <details
                className="section"
                data-project-section="quiet"
                aria-labelledby="quiet-projects-heading"
                open={revealQuietProjects}
              >
                <summary className="section-title disclosure-summary">
                  <span id="quiet-projects-heading" role="heading" aria-level={2}>
                    {strings.quietProjectsSection(quietProjects.length)}
                  </span>
                </summary>
                {renderGroups("quiet", 3)}
              </details>
            ) : null}
            {backlogProjects.length > 0 ? (
              <details
                className="section"
                data-project-section="backlog"
                aria-labelledby="backlog-projects-heading"
                open={revealBacklogProjects}
              >
                <summary className="section-title disclosure-summary">
                  <span id="backlog-projects-heading" role="heading" aria-level={2}>
                    {strings.backlogProjectsSection}
                  </span>
                </summary>
                {renderGroups("backlog", 3)}
              </details>
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
                {renderGroups("terminal", 3)}
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
