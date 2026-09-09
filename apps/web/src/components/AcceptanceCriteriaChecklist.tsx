import type { AcceptanceCriterion } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { useCriterionCheck } from "../lib/useCriterionCheck";
import { sortByPosition } from "../lib/taskHelpers";

/**
 * The compact, direct-manipulation projection of a project's acceptance
 * criteria: check/uncheck only, via the same mutation as the full
 * structural editor (see `useCriterionCheck`). No rename/delete/reorder/add
 * controls live here -- "using criteria is direct, changing the outcome's
 * structure is an explicit editing action" (see `story.editOutcome`,
 * opened by the caller's own "Ergebnis bearbeiten" action).
 */
export function AcceptanceCriteriaChecklist({
  projectId,
  criteria: criteriaProp,
}: {
  projectId: number;
  criteria: AcceptanceCriterion[];
}) {
  const strings = useStrings();
  const { check, pendingId, error } = useCriterionCheck(projectId);
  const criteria = sortByPosition(criteriaProp);

  if (criteria.length === 0) {
    return <p className="text-muted">{strings.outcomeSectionEmpty}</p>;
  }

  return (
    <div className="criteria-checklist">
      {error ? (
        <p className="capture-error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="criteria-checklist-list">
        {criteria.map((criterion) => (
          <li key={criterion.id} className="criteria-checklist-row">
            <label>
              <input
                type="checkbox"
                checked={criterion.checked}
                disabled={pendingId === criterion.id}
                onChange={() => void check(criterion.id, !criterion.checked)}
              />
              <span
                className={criterion.checked ? "criteria-checklist-text-done" : undefined}
              >
                {criterion.text}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
