import { useStrings } from "../lib/strings";
import { BottomSheet } from "./BottomSheet";

/**
 * Shown whenever a project is deleted. Deleting the project must never
 * silently decide the fate of its tasks — mirrors `ChildPolicyPrompt`'s
 * "ask explicitly" pattern for a task's open descendants.
 */
export function ProjectDeleteChoiceSheet({
  projectTitle,
  busy,
  onChoose,
  onClose,
}: {
  projectTitle: string;
  busy: boolean;
  onChoose: (deleteTasks: boolean) => void;
  onClose: () => void;
}) {
  const strings = useStrings();
  return (
    <BottomSheet
      title={strings.deleteProjectChoiceTitle}
      onClose={() => {
        if (!busy) onClose();
      }}
      labelledBy="project-delete-choice-title"
    >
      <p className="text-muted">{projectTitle}</p>
      <p>{strings.deleteProjectChoicePrompt}</p>
      <div className="stack">
        <button
          type="button"
          className="btn btn-block btn-primary"
          disabled={busy}
          onClick={() => onChoose(false)}
        >
          {strings.deleteProjectOnlyLabel}
          <span className="text-muted"> – {strings.deleteProjectOnlyHint}</span>
        </button>
        <button
          type="button"
          className="btn btn-block btn-danger"
          disabled={busy}
          onClick={() => onChoose(true)}
        >
          {strings.deleteProjectWithTasksLabel}
          <span className="text-muted"> – {strings.deleteProjectWithTasksHint}</span>
        </button>
        <button type="button" className="btn btn-ghost btn-block" disabled={busy} onClick={onClose}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
