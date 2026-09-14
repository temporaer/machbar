import type { ProjectWithActions } from "../lib/api";
import { useStrings } from "../lib/strings";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { BottomSheet } from "./BottomSheet";

/**
 * Focused `story.structure` workflow — the fixed row rail's `Struktur`
 * button for projects. Exactly `story.planWork` (navigates to the
 * project's next-action focus) and `story.editOutcome` (opens
 * `StoryCriteriaSheet`); each tile only dispatches the semantic command,
 * so `useWorkItemCommands()` stays the one place deciding what it opens.
 * `story.editOutcome` is additionally reachable from the contextual icon
 * button next to the outcome section in `ProjectDetailPage.tsx` — this
 * sheet does not duplicate that, it just offers the same command here too.
 */
export function ProjectStructureSheet({
  story,
  onClose,
}: {
  story: ProjectWithActions;
  onClose: () => void;
}) {
  const strings = useStrings();
  const dispatch = useWorkItemCommands();

  return (
    <BottomSheet title={`${strings.structure}: ${story.title}`} onClose={onClose}>
      <div className="stack">
        <button
          type="button"
          className="btn"
          onClick={() => {
            onClose();
            dispatch({ type: "story.planWork", story });
          }}
        >
          {strings.structurePlanWork}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => dispatch({ type: "story.editOutcome", story })}
        >
          {strings.structureEditOutcome}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
