import { useState } from "react";
import type { AcceptanceCriterion } from "@machbar/shared";
import { api } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { sortByPosition } from "../lib/taskHelpers";

/**
 * The ordered acceptance-criteria list of a story — progress, per-criterion
 * check/edit/reorder/remove, and the "add another" row. Structured criteria
 * replaced the old free-text project description, so this is the *only*
 * place a story's intent is spelled out, which is why it is shared verbatim
 * between the full `ProjectEditSheet` and the Backlog-review row's targeted
 * `StoryCriteriaSheet` instead of being duplicated (or, worse, only being
 * reachable by navigating away from the backlog list).
 *
 * Every mutation writes through immediately and `bump()`s the global
 * refresh bus, so the `criteria` prop is always re-supplied by the owning
 * screen rather than mirrored in local state; only the in-progress text
 * drafts live here.
 */
export function AcceptanceCriteriaEditor({
  projectId,
  criteria: criteriaProp,
  onError,
  autoFocusNewCriterion = false,
}: {
  projectId: number;
  criteria: AcceptanceCriterion[];
  /** Reports a failed mutation to the surrounding sheet (`null` clears it). */
  onError: (message: string | null) => void;
  autoFocusNewCriterion?: boolean;
}) {
  const strings = useStrings();
  const { bump } = useRefresh();
  const [newCriterionText, setNewCriterionText] = useState("");
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const criteria = sortByPosition(criteriaProp);
  const total = criteria.length;
  const done = criteria.filter((c) => c.checked).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const run = async (job: () => Promise<unknown>) => {
    onError(null);
    try {
      await job();
      bump();
    } catch (err) {
      onError(localizedErrorMessage(err, strings));
    }
  };

  const draftFor = (criterion: AcceptanceCriterion) => drafts[criterion.id] ?? criterion.text;

  const saveCriterionText = (criterion: AcceptanceCriterion) => {
    const draft = drafts[criterion.id];
    if (draft === undefined || draft === criterion.text || draft.trim() === "") return;
    return run(() => api.updateCriterion(projectId, criterion.id, draft.trim()));
  };

  const moveCriterion = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= criteria.length) return;
    const reordered = [...criteria];
    const [moved] = reordered.splice(index, 1);
    if (!moved) return;
    reordered.splice(target, 0, moved);
    return run(() =>
      api.reorderCriteria(
        projectId,
        reordered.map((c) => c.id),
      ),
    );
  };

  const addCriterion = async () => {
    const text = newCriterionText.trim();
    if (!text) return;
    await run(() => api.addCriterion(projectId, text));
    setNewCriterionText("");
  };

  return (
    <div className="field">
      <label>{strings.criteria}</label>
      {total > 0 ? (
        <>
          <p className="text-muted">
            {done}/{total} {strings.criteria}
          </p>
          <div className="criteria-progress">
            <span style={{ width: `${pct}%` }} />
          </div>
        </>
      ) : (
        <p className="text-muted">{strings.noCriteria}</p>
      )}

      {criteria.map((criterion, index) => (
        <div className="criterion-row" key={criterion.id}>
          <input
            type="checkbox"
            aria-label={criterion.text}
            checked={criterion.checked}
            onChange={() =>
              void run(() => api.checkCriterion(projectId, criterion.id, !criterion.checked))
            }
          />
          <input
            type="text"
            aria-label={`${strings.criteria} ${index + 1}`}
            value={draftFor(criterion)}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [criterion.id]: e.target.value }))}
            onBlur={() => void saveCriterionText(criterion)}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label={strings.moveCriterionUp}
            disabled={index === 0}
            onClick={() => void moveCriterion(index, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={strings.moveCriterionDown}
            disabled={index === criteria.length - 1}
            onClick={() => void moveCriterion(index, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={strings.removeCriterion}
            onClick={() => void run(() => api.removeCriterion(projectId, criterion.id))}
          >
            ×
          </button>
        </div>
      ))}

      <div className="row">
        <input
          type="text"
          style={{ flex: 1 }}
          autoFocus={autoFocusNewCriterion}
          placeholder={strings.addCriterionPlaceholder}
          aria-label={strings.addCriterionPlaceholder}
          value={newCriterionText}
          onChange={(e) => setNewCriterionText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addCriterion();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={!newCriterionText.trim()}
          onClick={() => void addCriterion()}
        >
          {strings.addCriterion}
        </button>
      </div>
    </div>
  );
}
