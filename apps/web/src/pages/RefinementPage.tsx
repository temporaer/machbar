import { useMemo, useState } from "react";
import { taskSizeLabels } from "@machbar/shared";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { strings } from "../lib/strings";
import { useRefinementActions } from "../lib/useRefinementActions";
import type { RefinementListItem } from "../lib/useRefinementActions";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncStates";
import { RefinementMatrix } from "../components/RefinementMatrix";
import type { RefinementMatrixSelection } from "../components/RefinementMatrix";
import { RefinementTaskRow } from "../components/RefinementTaskRow";
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
  const actions = useRefinementActions();

  const {
    data: ownerRows,
    loading: ownersLoading,
    error: ownersError,
    reload: reloadOwners,
  } = useAsync(() => api.getRefinementOwners(), []);
  const {
    data: taskRows,
    loading: tasksLoading,
    error: tasksError,
    reload: reloadTasks,
  } = useAsync(() => api.getRefinementTasks(), []);
  // `GET /api/refinement/tasks` doesn't carry blocked/waitingFor (see
  // `useRefinementActions.ts`'s `RefinementListItem` doc comment) — this
  // unfiltered `searchTasks` call (the same technique `SearchPage` already
  // uses for its initial, filter-less load) supplies them by task id.
  const { data: contextTasks } = useAsync(() => api.searchTasks({}), []);

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

  const loading = ownersLoading || tasksLoading;
  const error = ownersError ?? tasksError;

  return (
    <div>
      <div className="page-header">
        <h1>{strings.refinement}</h1>
      </div>

      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={() => { reloadOwners(); reloadTasks(); }} /> : null}

      {ownerRows ? (
        <div className="section">
          <div className="section-title">{strings.refinementMatrixTitle}</div>
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
