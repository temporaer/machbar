import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useLocale } from "../lib/locale";
import { useStrings } from "../lib/strings";
import { useRefinementActions } from "../lib/useRefinementActions";
import type { RefinementListItem } from "../lib/useRefinementActions";
import { groupItemsByTagKind, type GroupableTagKind } from "../lib/tagGrouping";
import { EmptyState, ErrorState, LoadingState } from "./AsyncStates";
import { CollapsibleGroup } from "./CollapsibleGroup";
import { RefinementMatrix, type RefinementMatrixSelection } from "./RefinementMatrix";
import { RefinementTaskRow } from "./RefinementTaskRow";
import { TagGroupingControl } from "./TagGroupingControl";
import "./RefinementTools.css";

export function RefinementTools() {
  const strings = useStrings();
  const { locale } = useLocale();
  const { members } = useIdentity();
  const [selection, setSelection] = useState<RefinementMatrixSelection | null>(null);
  const [groupBy, setGroupBy] = useState<GroupableTagKind | null>(null);
  const actions = useRefinementActions();
  const {
    data: ownerRows,
    loading: ownersLoading,
    error: ownersError,
    reload: reloadOwners,
  } = useAsync(() => api.getRefinementOwners({}), []);
  const {
    data: taskRows,
    loading: tasksLoading,
    error: tasksError,
    reload: reloadTasks,
  } = useAsync(() => api.getRefinementTasks({}), []);

  const ownerNameById = useMemo(() => {
    const names = new Map<number, string>();
    for (const row of ownerRows ?? []) {
      if (row.ownerId !== null && row.ownerName) names.set(row.ownerId, row.ownerName);
    }
    return names;
  }, [ownerRows]);
  const listItems = useMemo<RefinementListItem[]>(() => {
    if (!taskRows) return [];
    const retainedOnly = [...actions.retained.values()].filter(
      (retained) => !taskRows.some((task) => task.id === retained.id),
    );
    return [
      ...taskRows.map((task) => actions.retained.get(task.id) ?? task),
      ...retainedOnly,
    ];
  }, [actions.retained, taskRows]);
  const filteredItems = selection
    ? listItems.filter((item) => {
        if (item.effectiveOwnerId !== selection.ownerId) return false;
        if (selection.size === undefined) return true;
        return selection.size === "unestimated"
          ? item.size === null
          : item.size === selection.size;
      })
    : listItems;
  const groupedItems = groupBy
    ? groupItemsByTagKind(filteredItems, groupBy, locale)
    : [{ tag: null, items: filteredItems }];
  const selectionLabel = selection
    ? `${
        selection.ownerId === null
          ? strings.shared
          : ownerNameById.get(selection.ownerId) ?? strings.unassigned
      } · ${
        selection.size === undefined
          ? strings.allSizes
          : selection.size === "unestimated"
            ? strings.unestimated
            : strings.taskSizeLabels[selection.size]
      }`
    : null;
  const loading = ownersLoading || tasksLoading;
  const error = ownersError ?? tasksError;

  return (
    <div>
      <div className="projects-controls">
        <TagGroupingControl value={groupBy} onChange={setGroupBy} />
      </div>
      {loading ? <LoadingState /> : null}
      {error ? (
        <ErrorState
          message={error}
          onRetry={() => {
            reloadOwners();
            reloadTasks();
          }}
        />
      ) : null}
      {ownerRows ? (
        <div className="section refinement-secondary">
          <div className="section-title">{strings.effortGuide}</div>
          <RefinementMatrix
            rows={ownerRows}
            selection={selection}
            onSelect={setSelection}
            members={members}
          />
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
        {selectionLabel ? (
          <p className="text-muted refinement-filter-label">
            {strings.filteredBy}: {selectionLabel}
          </p>
        ) : null}
        {taskRows && filteredItems.length === 0 ? (
          <EmptyState message={strings.refinementEmpty} />
        ) : null}
        {groupedItems.map((group) =>
          groupBy ? (
            <CollapsibleGroup
              key={`${groupBy}-${group.tag?.id ?? "none"}`}
              title={group.tag?.name ?? strings.withoutTagKindLabels[groupBy]}
              headingLevel={3}
            >
              <ul className="list refinement-list">
                {group.items.map((item) => (
                  <RefinementTaskRow
                    key={item.id}
                    task={item}
                    ownerName={
                      item.effectiveOwnerId === null
                        ? null
                        : ownerNameById.get(item.effectiveOwnerId) ?? null
                    }
                    actions={actions}
                  />
                ))}
              </ul>
            </CollapsibleGroup>
          ) : (
            <ul className="list refinement-list" key="all">
              {group.items.map((item) => (
                <RefinementTaskRow
                  key={item.id}
                  task={item}
                  ownerName={
                    item.effectiveOwnerId === null
                      ? null
                      : ownerNameById.get(item.effectiveOwnerId) ?? null
                  }
                  actions={actions}
                />
              ))}
            </ul>
          ),
        )}
      </div>
    </div>
  );
}
