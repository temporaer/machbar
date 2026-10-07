import { useEffect, useRef, useState } from "react";
import type { AcceptanceCriterion } from "@machbar/shared";
import { api } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { localizedErrorMessage } from "../lib/errorMessage";
import { sortByPosition } from "../lib/taskHelpers";
import { useCriterionCheck } from "../lib/useCriterionCheck";

/**
 * The ordered acceptance-criteria list of a story — progress, per-criterion
 * check/edit/reorder/remove, and the "add another" row. Structured criteria
 * replaced the old free-text project description, so this is the *only*
 * place a story's intent is spelled out, which is why it is shared verbatim
 * between the full `ProjectEditSheet` and the Backlog-review row's targeted
 * `StoryCriteriaSheet` instead of being duplicated (or, worse, only being
 * reachable by navigating away from the backlog list).
 *
 * Checkbox, order, removal, and addition mutations write through immediately.
 * Text drafts require an explicit save. Successful mutations `bump()` the
 * global refresh bus, so persisted criteria remain owned by the parent.
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
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const {
    check: checkCriterion,
    pendingId: checkingCriterionId,
    error: criterionCheckError,
  } = useCriterionCheck(projectId);

  const criteria = sortByPosition(criteriaProp);
  const total = criteria.length;
  const done = criteria.filter((c) => c.checked).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const busy = pending || checkingCriterionId !== null;

  useEffect(() => {
    if (criterionCheckError) onError(criterionCheckError);
  }, [criterionCheckError, onError]);

  const run = async (job: () => Promise<unknown>) => {
    if (pendingRef.current || checkingCriterionId !== null) return false;
    pendingRef.current = true;
    setPending(true);
    onError(null);
    try {
      await job();
      bump();
      return true;
    } catch (err) {
      onError(localizedErrorMessage(err, strings));
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const draftFor = (criterion: AcceptanceCriterion) => drafts[criterion.id] ?? criterion.text;

  const saveCriterionText = async (criterion: AcceptanceCriterion) => {
    const draft = drafts[criterion.id];
    if (draft === undefined || draft.trim() === "") return;
    if (draft.trim() !== criterion.text) {
      const saved = await run(() => api.updateCriterion(projectId, criterion.id, draft.trim()));
      if (!saved) return;
    }
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[criterion.id];
      return next;
    });
    setEditingId(null);
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
    const added = await run(() => api.addCriterion(projectId, text));
    if (added) setNewCriterionText("");
  };

  const cancelEditing = (criterionId: number) => {
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[criterionId];
      return next;
    });
    setEditingId(null);
    onError(null);
  };

  const editing = editingId !== null;

  return (
    <div className="field" aria-busy={busy}>
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
            disabled={busy || editing}
            onChange={() =>
              void checkCriterion(criterion.id, !criterion.checked)
            }
          />
          <input
            type="text"
            aria-label={`${strings.criteria} ${index + 1}`}
            value={editingId === criterion.id ? draftFor(criterion) : criterion.text}
            readOnly={editingId !== criterion.id}
            disabled={busy && editingId === criterion.id}
            autoFocus={editingId === criterion.id}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [criterion.id]: e.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busy && editingId === criterion.id) {
                event.preventDefault();
                cancelEditing(criterion.id);
              }
            }}
          />
          {editingId === criterion.id ? (
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={
                  busy ||
                  !draftFor(criterion).trim() ||
                  draftFor(criterion).trim() === criterion.text
                }
                onClick={() => void saveCriterionText(criterion)}
              >
                {strings.save}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy}
                onClick={() => cancelEditing(criterion.id)}
              >
                {strings.cancel}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy || editing}
              onClick={() => {
                onError(null);
                setDrafts((previous) => ({ ...previous, [criterion.id]: criterion.text }));
                setEditingId(criterion.id);
              }}
            >
              {strings.edit}
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label={strings.moveCriterionUp}
            disabled={busy || editing || index === 0}
            onClick={() => void moveCriterion(index, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={strings.moveCriterionDown}
            disabled={busy || editing || index === criteria.length - 1}
            onClick={() => void moveCriterion(index, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={strings.removeCriterion}
            disabled={busy || editing}
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
          disabled={busy || editing}
          onChange={(e) => setNewCriterionText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy && !editing) {
              e.preventDefault();
              void addCriterion();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || editing || !newCriterionText.trim()}
          onClick={() => void addCriterion()}
        >
          {strings.addCriterion}
        </button>
      </div>
    </div>
  );
}
