import type { TaskSize } from "@machbar/shared";
import { taskSizes, taskSizeLabels } from "@machbar/shared";
import { strings } from "../lib/strings";
import type { OwnerSizeCounts } from "../lib/api";

/**
 * The list-filtering selection a matrix cell/row/column represents. `owner`
 * is a member id or `null` for the shared/unassigned ("Gemeinsam / offen")
 * row; `size` is a concrete `TaskSize`, `"unestimated"` for that column, or
 * `undefined` for "every size" (row-header / row total click).
 */
export interface RefinementMatrixSelection {
  ownerId: number | null;
  size?: TaskSize | "unestimated";
}

function selectionsEqual(a: RefinementMatrixSelection | null, b: RefinementMatrixSelection): boolean {
  return !!a && a.ownerId === b.ownerId && a.size === b.size;
}

/**
 * The effective-owner × S/M/L/XL/unestimated matrix. Every owner row
 * (including the trailing shared/unassigned row the backend always
 * includes — see `getRefinementOwnerSizeCounts`) and every size column,
 * plus each row's total, is an individually clickable/focusable button so
 * the task list below can be filtered by owner and/or size without any
 * gesture — matrix cells are a plain `<table>` of `<button>`s, fully
 * keyboard operable.
 */
export function RefinementMatrix({
  rows,
  selection,
  onSelect,
}: {
  rows: OwnerSizeCounts[];
  selection: RefinementMatrixSelection | null;
  onSelect: (selection: RefinementMatrixSelection | null) => void;
}) {
  const columns: Array<TaskSize | "unestimated"> = [...taskSizes, "unestimated"];

  function toggle(next: RefinementMatrixSelection) {
    onSelect(selectionsEqual(selection, next) ? null : next);
  }

  return (
    <div className="refinement-matrix-wrap">
      <table className="refinement-matrix">
        <caption className="sr-only">{strings.refinementMatrixTitle}</caption>
        <thead>
          <tr>
            <th scope="col">{strings.owner}</th>
            {columns.map((col) => (
              <th scope="col" key={col}>
                {col === "unestimated" ? strings.unestimated : taskSizeLabels[col]}
              </th>
            ))}
            <th scope="col">{strings.total}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.ownerId ?? "shared"}>
              <th scope="row">
                <button
                  type="button"
                  className="refinement-matrix-cell owner"
                  aria-pressed={selectionsEqual(selection, { ownerId: row.ownerId })}
                  onClick={() => toggle({ ownerId: row.ownerId })}
                >
                  {row.ownerId === null ? strings.shared : row.ownerName ?? strings.unassigned}
                </button>
              </th>
              {columns.map((col) => (
                <td key={col}>
                  <button
                    type="button"
                    className="refinement-matrix-cell"
                    aria-pressed={selectionsEqual(selection, { ownerId: row.ownerId, size: col })}
                    onClick={() => toggle({ ownerId: row.ownerId, size: col })}
                  >
                    {row[col]}
                  </button>
                </td>
              ))}
              <td>
                <span className="refinement-matrix-total">{row.total}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
