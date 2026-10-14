import { useEffect, useRef, useState } from "react";
import { api, type ProjectDetail, type ProjectWithActions } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { projectActivationPromptFromError, projectActivationResolutionFromPrompt, type ProjectActivationPrompt } from "../lib/projectActivationResolution";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import { BottomSheet } from "./BottomSheet";
import { ErrorState, LoadingState } from "./AsyncStates";

/**
 * Focused `story.convertToTask` workflow. The work-item id is retained;
 * task children and checkable acceptance criteria stay attached to it.
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
  const [title, setTitle] = useState(story.title);
  const [notes, setNotes] = useState(story.notes ?? "");
  const [titleEdited, setTitleEdited] = useState(false);
  const [notesEdited, setNotesEdited] = useState(false);
  const baseline = useRef({ title: story.title, notes: story.notes ?? "" });
  const [conflicts, setConflicts] = useState<Array<"title" | "notes">>([]);
  const [freshProject, setFreshProject] = useState<ProjectDetail | null>(null);
  const [activationPrompt, setActivationPrompt] = useState<ProjectActivationPrompt | null>(null);
  const activationResolution = activationPrompt ? projectActivationResolutionFromPrompt(activationPrompt) : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    data: project,
    loading,
    error: loadError,
    reload,
  } = useAsync<ProjectDetail>(() => api.getProject(story.id), [story.id]);

  const currentProject = freshProject ?? project;

  useEffect(() => {
    if (!currentProject) return;
    if (!titleEdited) {
      baseline.current.title = currentProject.title;
      setTitle(currentProject.title);
    }
    if (!notesEdited) {
      baseline.current.notes = currentProject.notes ?? "";
      setNotes(currentProject.notes ?? "");
    }
  }, [currentProject, titleEdited, notesEdited]);

  useEffect(() => {
    if (freshProject && project && project.revision >= freshProject.revision) {
      setFreshProject(null);
    }
  }, [freshProject, project]);

  const hasChildren = (currentProject?.tasks.length ?? 0) > 0;
  const hasAcceptanceCriteria = (currentProject?.acceptanceCriteria ?? []).length > 0;
  const canConvert = currentProject !== null && currentProject !== undefined && currentProject.status !== "archived" && (currentProject.childStories?.length ?? 0) === 0;

  const convert = async () => {
    if (busy || !canConvert || !currentProject || conflicts.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.convertStoryToTask(story.id, {
        ...(titleEdited ? { title } : {}),
        ...(notesEdited ? { notes } : {}),
        expectedRevision: currentProject.revision,
        ...(activationResolution ? { activationResolution } : {}),
        ...(currentProject.hierarchyRevisions ? { expectedHierarchyRevisions: currentProject.hierarchyRevisions } : {}),
      });
      bump();
      onClose();
    } catch (cause) {
      const prompt = projectActivationPromptFromError(cause, activationPrompt);
      if (prompt) setActivationPrompt(prompt);
      if (isStaleWriteConflict(cause)) {
        try {
          const latest = await api.getProject(story.id);
          setFreshProject(latest);
          const nextConflicts: Array<"title" | "notes"> = [];
          if (!titleEdited || latest.title === title) {
            baseline.current.title = latest.title;
            if (titleEdited && latest.title === title) setTitleEdited(false);
            if (!titleEdited) setTitle(latest.title);
          } else if (latest.title !== baseline.current.title) {
            nextConflicts.push("title");
          }
          const latestNotes = latest.notes ?? "";
          if (!notesEdited || latestNotes === notes) {
            baseline.current.notes = latestNotes;
            if (notesEdited && latestNotes === notes) setNotesEdited(false);
            if (!notesEdited) setNotes(latestNotes);
          } else if (latestNotes !== baseline.current.notes) {
            nextConflicts.push("notes");
          }
          setConflicts(nextConflicts);
        } catch {
          // Keep the authored draft; the next attempt can reload the current project.
        }
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
        {currentProject ? (
          <>
            {canConvert ? (
              <>
                <p className="text-muted">{strings.convertProjectToTaskReady}</p>
                {hasChildren ? <p className="text-muted">{strings.convertProjectToTaskChildrenPreserved(currentProject.tasks.length)}</p> : null}
                {hasAcceptanceCriteria ? <p className="text-muted">{strings.convertProjectToTaskCriteriaPreserved(currentProject.acceptanceCriteria.length)}</p> : null}
                <label className="field">
                  <span className="field-label">{strings.title}</span>
                  <input
                    className="input"
                    value={title}
                    onChange={(event) => {
                      const value = event.target.value;
                      setTitle(value);
                      setTitleEdited(value !== baseline.current.title);
                    }}
                    disabled={busy}
                  />
                  {conflicts.includes("title") ? (
                    <div className="stack" role="alert">
                      <span>{strings.convertProjectToTaskFieldConflict}: {strings.title}</span>
                      <div className="capture-shape-actions">
                        <button type="button" className="btn" onClick={() => {
                          const latest = freshProject?.title ?? currentProject.title;
                          baseline.current.title = latest;
                          setTitle(latest);
                          setTitleEdited(false);
                          setConflicts((previous) => previous.filter((field) => field !== "title"));
                        }}>{strings.convertProjectToTaskUseLatest}</button>
                        <button type="button" className="btn" onClick={() => {
                          baseline.current.title = freshProject?.title ?? currentProject.title;
                          setTitleEdited(true);
                          setConflicts((previous) => previous.filter((field) => field !== "title"));
                        }}>{strings.convertProjectToTaskKeepMyEdit}</button>
                      </div>
                    </div>
                  ) : null}
                </label>
                <label className="field">
                  <span className="field-label">{strings.notes}</span>
                  <textarea
                    className="input"
                    value={notes}
                    onChange={(event) => {
                      const value = event.target.value;
                      setNotes(value);
                      setNotesEdited(value !== baseline.current.notes);
                    }}
                    disabled={busy}
                    rows={4}
                  />
                  {conflicts.includes("notes") ? (
                    <div className="stack" role="alert">
                      <span>{strings.convertProjectToTaskFieldConflict}: {strings.notes}</span>
                      <div className="capture-shape-actions">
                        <button type="button" className="btn" onClick={() => {
                          const latest = freshProject?.notes ?? currentProject.notes ?? "";
                          baseline.current.notes = latest;
                          setNotes(latest);
                          setNotesEdited(false);
                          setConflicts((previous) => previous.filter((field) => field !== "notes"));
                        }}>{strings.convertProjectToTaskUseLatest}</button>
                        <button type="button" className="btn" onClick={() => {
                          baseline.current.notes = freshProject?.notes ?? currentProject.notes ?? "";
                          setNotesEdited(true);
                          setConflicts((previous) => previous.filter((field) => field !== "notes"));
                        }}>{strings.convertProjectToTaskKeepMyEdit}</button>
                      </div>
                    </div>
                  ) : null}
                </label>
                {activationPrompt ? <ProjectActivationDecisionFields prompt={activationPrompt} disabled={busy} onChange={setActivationPrompt} /> : null}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || title.trim() === "" || !canConvert || conflicts.length > 0 || (!!activationPrompt && !activationResolution)}
                  onClick={() => void convert()}
                >
                  {strings.convertProjectToTask}
                </button>
              </>
            ) : (
              <>
                <p className="text-muted">{strings.convertProjectToTaskUnsupported}</p>
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
