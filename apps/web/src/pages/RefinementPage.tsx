import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { tagKinds, taskSizeLabels } from "@machbar/shared";
import type { RefinementIssue } from "@machbar/shared";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { strings } from "../lib/strings";
import { useRefinementActions } from "../lib/useRefinementActions";
import type { RefinementListItem } from "../lib/useRefinementActions";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { RefinementMatrix } from "../components/RefinementMatrix";
import type { RefinementMatrixSelection } from "../components/RefinementMatrix";
import { RefinementTaskRow } from "../components/RefinementTaskRow";
import { useTaskDetail } from "../lib/taskDetailContext";
import "./RefinementPage.css";

function selectionLabel(
  selection: RefinementMatrixSelection,
  ownerNameById: Map<number, string>,
): string {
  const ownerPart =
    selection.ownerId === null ? strings.shared : ownerNameById.get(selection.ownerId) ?? strings.unassigned;
  const sizePart =
    selection.size === undefined
      ? strings.allSizes
      : selection.size === "unestimated"
        ? strings.unestimated
        : taskSizeLabels[selection.size];
  return `${ownerPart} · ${sizePart}`;
}

/**
 * The Scrum refinement view: an effective-owner × S/M/L/XL/unestimated
 * matrix (including the always-present "Gemeinsam / offen" shared row) on
 * top of a list of every open task still needing refinement, with its
 * owner, story (project), current size and blocked/waiting context. A
 * matrix cell/row/column filters the list below; the list itself supports
 * a right-swipe size-cycle, a left-swipe/kebab chip strip with direct
 * S/M/L/XL/clear choices, a targeted Zuweisen popup (the same focused
 * `AssignOwnerSheet` the task chip strip uses) and the Zum-Projekt
 * navigation used elsewhere in the app.
 */
export function RefinementPage() {
  const [selection, setSelection] = useState<RefinementMatrixSelection | null>(null);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const actions = useRefinementActions();
  const navigate = useNavigate();
  const taskDetail = useTaskDetail();
  const {
    data: issueResult,
    loading: issuesLoading,
    error: issuesError,
    reload: reloadIssues,
  } = useAsync(() => api.getRefinementIssues(), []);

  const {
    data: ownerRows,
    loading: ownersLoading,
    error: ownersError,
    reload: reloadOwners,
  } = useAsync(() => api.getRefinementOwners({ tagIds }), [JSON.stringify(tagIds)]);
  const {
    data: taskRows,
    loading: tasksLoading,
    error: tasksError,
    reload: reloadTasks,
  } = useAsync(() => api.getRefinementTasks({ tagIds }), [JSON.stringify(tagIds)]);
  // `GET /api/refinement/tasks` doesn't carry blocked/waitingFor (see
  // `useRefinementActions.ts`'s `RefinementListItem` doc comment) — this
  // unfiltered `searchTasks` call (the same technique `SearchPage` already
  // uses for its initial, filter-less load) supplies them by task id.
  const { data: contextTasks } = useAsync(
    () => api.searchTasks({ tagIds }),
    [JSON.stringify(tagIds)],
  );
  const { data: tags } = useAsync(() => api.getTags(), []);

  const ownerNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of ownerRows ?? []) {
      if (row.ownerId !== null && row.ownerName) map.set(row.ownerId, row.ownerName);
    }
    return map;
  }, [ownerRows]);

  const listItems = useMemo<RefinementListItem[]>(() => {
    if (!taskRows) return [];
    const contextById = new Map((contextTasks ?? []).map((t) => [t.id, t]));
    return taskRows.map((row) => {
      const ctx = contextById.get(row.id);
      return { ...row, blocked: ctx?.blocked ?? false, waitingFor: ctx?.waitingFor ?? null };
    });
  }, [taskRows, contextTasks]);

  const filteredItems = useMemo(() => {
    if (!selection) return listItems;
    return listItems.filter((item) => {
      if (item.effectiveOwnerId !== selection.ownerId) return false;
      if (selection.size === undefined) return true;
      if (selection.size === "unestimated") return item.size === null;
      return item.size === selection.size;
    });
  }, [listItems, selection]);

  const loading = issuesLoading || ownersLoading || tasksLoading;
  const error = issuesError ?? ownersError ?? tasksError;

  const repair = (issue: RefinementIssue) => {
    if (issue.entityType === "project") {
      navigate(`/projekte/${issue.entityId}`);
      return;
    }
    const focus =
      issue.suggestedAction.code === "assign_task"
        ? "owner"
        : issue.suggestedAction.code === "set_followup" ||
            issue.suggestedAction.code === "follow_up" ||
            issue.suggestedAction.code === "plan_task"
          ? "schedule"
          : undefined;
    taskDetail.open(issue.entityId, focus);
  };

  return (
    <div>
      <div className="page-header">
        <h1>{strings.refinement}</h1>
      </div>
      <div className="stack">
        {tagKinds.map((kind) => {
          const kindTags = (tags ?? []).filter((tag) => tag.kind === kind);
          if (kindTags.length === 0) return null;
          return (
            <div key={kind}>
              <p className="text-muted">{strings.tagKindLabels[kind]}</p>
              <div className="row" role="group" aria-label={strings.tagKindLabels[kind]}>
                {kindTags.map((tag) => {
                  const selected = tagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      className="chip"
                      aria-pressed={selected}
                      onClick={() =>
                        setTagIds((current) =>
                          selected
                            ? current.filter((id) => id !== tag.id)
                            : [...current, tag.id],
                        )
                      }
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {loading ? <LoadingState /> : null}
      {error ? (
        <ErrorState
          message={error}
          onRetry={() => {
            reloadIssues();
            reloadOwners();
            reloadTasks();
          }}
        />
      ) : null}

      <section className="section" aria-labelledby="clarification-needs-heading">
        <h2 className="section-title" id="clarification-needs-heading">
          {strings.clarificationNeeds}
        </h2>
        <p className="text-muted">{strings.clarificationNeedsHint}</p>
        {issueResult?.issues.length === 0 ? (
          <EmptyState message={strings.clarificationNeedsEmpty} />
        ) : null}
        <div className="clarification-issue-list">
          {issueResult?.issues.map((issue) => (
            <article
              className={`card clarification-issue clarification-issue--${issue.severity}`}
              key={`${issue.entityType}-${issue.entityId}-${issue.code}`}
            >
              <div>
                <strong>{issue.entityTitle}</strong>
                {issue.projectTitle && issue.entityType === "task" ? (
                  <span className="text-muted"> · {issue.projectTitle}</span>
                ) : null}
              </div>
              <div className="clarification-issue-label">{issue.label}</div>
              <p className="text-muted">{issue.explanation}</p>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => repair(issue)}
              >
                {issue.suggestedAction.label}
              </button>
            </article>
          ))}
        </div>
      </section>

      {ownerRows ? (
        <div className="section refinement-secondary">
          <div className="section-title">{strings.effortGuide}</div>
          <p className="text-muted">{strings.effortGuideHint}</p>
          <p className="text-muted">{strings.refinementMatrixHint}</p>
          <RefinementMatrix rows={ownerRows} selection={selection} onSelect={setSelection} />
        </div>
      ) : null}

      <div className="section" style={{ marginTop: 16 }}>
        <div className="row-between section-title">
          <span>{strings.refinementListTitle}</span>
          {selection ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelection(null)}>
              {strings.resetFilter}
            </button>
          ) : null}
        </div>
        {selection ? (
          <p className="text-muted refinement-filter-label">
            {strings.filteredBy}: {selectionLabel(selection, ownerNameById)}
          </p>
        ) : null}
        <p className="text-muted refinement-swipe-hint">
          {strings.swipeHintSize} · {strings.swipeHintSizeChips}
        </p>
        {taskRows && filteredItems.length === 0 ? <EmptyState message={strings.refinementEmpty} /> : null}
        {filteredItems.length > 0 ? (
          <ul className="list refinement-list" style={{ padding: 0, margin: 0 }}>
            {filteredItems.map((item) => (
              <RefinementTaskRow
                key={item.id}
                task={item}
                ownerName={item.effectiveOwnerId !== null ? ownerNameById.get(item.effectiveOwnerId) ?? null : null}
                actions={actions}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
