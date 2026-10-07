import { useState } from "react";
import { api, type ProjectDetail, type ProjectWithActions } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { BottomSheet } from "./BottomSheet";
import { ErrorState, LoadingState } from "./AsyncStates";

/**
 * Focused `story.convertToTask` workflow. It preflights project-only
 * structure and exposes existing repair surfaces instead of discarding it.
 */
export function ProjectConvertToTaskSheet({
  story,
  onClose,
}: {
  story: ProjectWithActions;
  onClose: () => void;
}) {
  const strings = useStrings();
  const { bump } = useRefresh();
  const dispatch = useWorkItemCommands();
  const [title, setTitle] = useState(story.title);
  const [notes, setNotes] = useState(story.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    data: project,
    loading,
    error: loadError,
    reload,
  } = useAsync<ProjectDetail>(() => api.getProject(story.id), [story.id]);

  const hasChildren = (project?.tasks.length ?? 0) > 0;
  const hasAcceptanceCriteria = (project?.acceptanceCriteria ?? []).length > 0;
  const canConvert = project !== undefined && !hasChildren && !hasAcceptanceCriteria;

  const convert = async () => {
    if (busy || !canConvert || !project) return;
    setBusy(true);
    setError(null);
    try {
      await api.convertStoryToTask(story.id, {
        title,
        notes,
        expectedRevision: project.revision,
      });
      bump();
      onClose();
    } catch (cause) {
      if (isStaleWriteConflict(cause)) {
        bump();
        reload();
      }
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      title={strings.convertProjectToTaskTitle}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="stack">
        {loading && !project ? <LoadingState /> : null}
        {loadError && !project ? (
          <ErrorState
            message={localizedErrorMessage(loadError, strings)}
            onRetry={reload}
          />
        ) : null}
        {project ? (
          <>
            {canConvert ? (
              <>
                <p className="text-muted">{strings.convertProjectToTaskReady}</p>
                <label className="field">
                  <span className="field-label">{strings.title}</span>
                  <input
                    className="input"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    disabled={busy}
                  />
                </label>
                <label className="field">
                  <span className="field-label">{strings.notes}</span>
                  <textarea
                    className="input"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    disabled={busy}
                    rows={4}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || title.trim() === "" || !canConvert}
                  onClick={() => void convert()}
                >
                  {strings.convertProjectToTask}
                </button>
              </>
            ) : (
              <>
                <p className="text-muted">{strings.convertProjectToTaskBlocked}</p>
                {hasChildren ? (
                  <div className="stack">
                    <p>{strings.convertProjectToTaskHasChildren}</p>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        dispatch({ type: "story.structure", story })
                      }
                    >
                      {strings.convertProjectToTaskOpenStructure}
                    </button>
                  </div>
                ) : null}
                {hasAcceptanceCriteria ? (
                  <div className="stack">
                    <p>{strings.convertProjectToTaskHasCriteria}</p>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        dispatch({ type: "story.editOutcome", story })
                      }
                    >
                      {strings.convertProjectToTaskEditGoal}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </>
        ) : null}
        {error ? (
          <div className="task-row-error" role="alert">
            {error}
          </div>
        ) : null}
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
