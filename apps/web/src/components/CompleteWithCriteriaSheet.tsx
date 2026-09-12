import type { Project } from "@machbar/shared";
import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";
import { AcceptanceCriteriaChecklist } from "./AcceptanceCriteriaChecklist";

/**
 * The focused continuation for `story.complete` when acceptance criteria
 * remain unchecked (see `lifecyclePrerequisite()`): checking criteria is
 * direct manipulation via the shared `AcceptanceCriteriaChecklist`, not the
 * structural `story.editOutcome` editor. Completing is enabled only once
 * every criterion is checked, and commits the same `story.complete`
 * transition every other entry point uses.
 */
export function CompleteWithCriteriaSheet({
  story,
  onClose,
  onComplete,
}: {
  story: Project;
  onClose: () => void;
  onComplete: () => Promise<void>;
}) {
  const strings = useStrings();
  const criteria = story.acceptanceCriteria ?? [];
  const allChecked = criteria.every((criterion) => criterion.checked);

  return (
    <BottomSheet
      title={`${strings.completeWithCriteriaTitle}: ${story.title}`}
      onClose={onClose}
      labelledBy="complete-with-criteria-title"
    >
      <div className="stack">
        <p className="text-muted">{strings.completeWithCriteriaHint}</p>
        <AcceptanceCriteriaChecklist projectId={story.id} criteria={criteria} />
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!allChecked}
          onClick={async () => {
            await onComplete();
            onClose();
          }}
        >
          {strings.completeProjectAction}
        </button>
        <button type="button" className="btn btn-block" onClick={onClose}>
          {strings.close}
        </button>
      </div>
    </BottomSheet>
  );
}
