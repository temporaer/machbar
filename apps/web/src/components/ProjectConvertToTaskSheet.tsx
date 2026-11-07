import { useEffect, useRef, useState } from "react";
import { api, type ProjectDetail, type ProjectWithActions } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useProjectActions } from "../lib/useProjectActions";
import { useRefresh } from "../lib/refresh";
import { useStrings } from "../lib/strings";
import { isStaleWriteConflict, localizedErrorMessage } from "../lib/errorMessage";
import { projectActivationTargetIds, projectActivationPromptFromError, projectActivationResolutionFromPrompt, type ProjectActivationPrompt } from "../lib/projectActivationResolution";
import { ProjectActivationDecisionFields } from "./ProjectActivationDecisionFields";
import { BottomSheet, type BottomSheetPresentationProps } from "./BottomSheet";
import { ErrorState, LoadingState } from "./AsyncStates";

/**
 * Focused `story.convertToTask` workflow. The work-item id is retained;
 * task children and checkable acceptance criteria stay attached to it.
 */
export function ProjectConvertToTaskSheet({
  story,
  authoritativeProject = null,
  onClose,
  ...presentation
}: {
  story: ProjectWithActions;
  authoritativeProject?: ProjectDetail | null;
  onClose: () => void;
} & BottomSheetPresentationProps) {
  const strings = useStrings();
  const projectActions = useProjectActions();
  const { bump } = useRefresh();
  const [title, setTitle] = useState(story.title);
  const [notes, setNotes] = useState(story.notes ?? "");
  const [titleEdited, setTitleEdited] = useState(false);
  const [notesEdited, setNotesEdited] = useState(false);
  const baseline = useRef({ title: story.title, notes: story.notes ?? "", revision: null as number | null });
  const [conflicts, setConflicts] = useState<Array<"title" | "notes">>([]);
  const [freshProject, setFreshProject] = useState<ProjectDetail | null>(null);
  const [activationPrompt, setActivationPrompt] = useState<ProjectActivationPrompt | null>(null);
  const activationResolution = activationPrompt ? projectActivationResolutionFromPrompt(activationPrompt) : null;
  const activationUnavailable = activationPrompt?.readUnavailable || (activationPrompt?.isCurrentRead && !activationPrompt.isCurrentRead());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedProjectRead, setFailedProjectRead] = useState<{ id: number; error: string } | null>(null);
  const {
    data: project,
    loading,
    error: loadError,
    reload,
  } = useAsync<ProjectDetail>(() => projectActions.getProject(story.id), [story.id, projectActions.scopeToken]);

  const confirmedRead = freshProject && projectActions.isCurrentProjectRead(freshProject) ? freshProject : null;
  const queryRead = project && projectActions.isCurrentProjectRead(project) ? project : null;
  const localProject = confirmedRead && (!queryRead || confirmedRead.revision >= queryRead.revision) ? confirmedRead : queryRead;
  const hostProject = authoritativeProject?.id === story.id && projectActions.isCurrentProjectRead(authoritativeProject) ? authoritativeProject : null;
  const currentProject = hostProject && (!localProject || hostProject.revision >= localProject.revision) ? hostProject : localProject;

  useEffect(() => {
    if (queryRead) setFreshProject(previous => previous && queryRead.revision >= previous.revision ? null : previous);
  }, [queryRead]);

  useEffect(() => {
    if (hostProject) setFreshProject(previous => previous && hostProject.revision >= previous.revision ? null : previous);
  }, [hostProject]);

  useEffect(() => {
    if (!currentProject || (baseline.current.revision !== null && currentProject.revision < baseline.current.revision)) return;
    const nextConflicts = new Set(conflicts);
    if (!titleEdited || currentProject.title === title) {
      setTitle(currentProject.title);
      setTitleEdited(false);
      nextConflicts.delete("title");
    } else if (currentProject.title !== baseline.current.title) {
      nextConflicts.add("title");
    }
    const latestNotes = currentProject.notes ?? "";
    if (!notesEdited || latestNotes === notes) {
      setNotes(latestNotes);
      setNotesEdited(false);
      nextConflicts.delete("notes");
    } else if (latestNotes !== baseline.current.notes) {
      nextConflicts.add("notes");
    }
    baseline.current = { title: currentProject.title, notes: latestNotes, revision: currentProject.revision };
    setConflicts([...nextConflicts]);
  }, [currentProject, titleEdited, notesEdited]);

  const hasChildren = (currentProject?.tasks.length ?? 0) > 0;
  const hasAcceptanceCriteria = (currentProject?.acceptanceCriteria ?? []).length > 0;
  const canConvert = currentProject !== null && currentProject !== undefined && currentProject.status !== "archived" && (currentProject.childStories?.length ?? 0) === 0;

  const retryProjectRead = async () => {
    if (!failedProjectRead || busy || !currentProject) return;
    setBusy(true);
    try {
      const latest = await projectActions.getProject(failedProjectRead.id, cause => {
        if (projectActions.isCurrentProjectRead(currentProject)) setFailedProjectRead({ id: failedProjectRead.id, error: localizedErrorMessage(cause, strings) });
      });
      if (projectActions.isCurrentProjectRead(currentProject) && projectActions.isCurrentProjectRead(latest)) setFailedProjectRead(null);
    } catch { /* The matching reader reports its failure without recertifying a prompt. */ }
    finally { setBusy(false); }
  };

  const convert = async () => {
    if (busy || !canConvert || !currentProject || currentProject.revision !== baseline.current.revision || conflicts.length > 0) return;
    const affectedIds = new Set(projectActivationTargetIds(currentProject.id, currentProject.ancestors));
    const continuations = [...affectedIds].map(projectActions.captureTargetRead);
    const isCurrent = () => continuations.every(projectActions.isCurrentTargetRead);
    setBusy(true);
    setError(null);
    try {
      for (const id of affectedIds) {
        if (!projectActions.isTargetReadable(id)) {
          const current = await projectActions.getProject(id, cause => {
            if (isCurrent()) setFailedProjectRead({ id, error: localizedErrorMessage(cause, strings) });
          });
          if (!isCurrent() || !projectActions.isCurrentProjectRead(current)) return;
        }
      }
      await api.convertStoryToTask(story.id, {
        ...(titleEdited ? { title } : {}),
        ...(notesEdited ? { notes } : {}),
        expectedRevision: currentProject.revision,
        ...(activationResolution ? { activationResolution } : {}),
        ...(currentProject.hierarchyRevisions ? { expectedHierarchyRevisions: currentProject.hierarchyRevisions } : {}),
      });
      if (!isCurrent()) return;
      bump();
      onClose();
    } catch (cause) {
      if (!isCurrent()) return;
      const prompt = projectActivationPromptFromError(cause, activationPrompt);
      if (prompt) setActivationPrompt({ ...prompt, isCurrentRead: () => isCurrent() &&
        prompt.projects.every(project => affectedIds.has(project.projectId)) &&
        prompt.expectedProjects.every(project => affectedIds.has(project.projectId)) });
      if (isStaleWriteConflict(cause)) {
        setActivationPrompt(previous => previous ? { ...previous, readUnavailable: true } : previous);
        try {
          const latest = await projectActions.getProject(story.id);
          if (!isCurrent() || !projectActions.isCurrentProjectRead(latest)) return;
          setFreshProject(latest);
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
      {...presentation}
      title={strings.convertProjectToTaskTitle}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="stack">
        {loading && !project ? <LoadingState /> : null}
        {!currentProject && !loading ? (
          <ErrorState
            message={loadError ? localizedErrorMessage(loadError, strings) : strings.workflowTargetUnavailable}
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
                          const latest = currentProject.title;
                          baseline.current.title = latest;
                          setTitle(latest);
                          setTitleEdited(false);
                          setConflicts((previous) => previous.filter((field) => field !== "title"));
                        }}>{strings.convertProjectToTaskUseLatest}</button>
                        <button type="button" className="btn" onClick={() => {
                          baseline.current.title = currentProject.title;
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
                          const latest = currentProject.notes ?? "";
                          baseline.current.notes = latest;
                          setNotes(latest);
                          setNotesEdited(false);
                          setConflicts((previous) => previous.filter((field) => field !== "notes"));
                        }}>{strings.convertProjectToTaskUseLatest}</button>
                        <button type="button" className="btn" onClick={() => {
                          baseline.current.notes = currentProject.notes ?? "";
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
                  disabled={busy || failedProjectRead !== null || title.trim() === "" || !canConvert || currentProject.revision !== baseline.current.revision || conflicts.length > 0 || (!!activationPrompt && !activationUnavailable && !activationResolution)}
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
        {failedProjectRead ? <ErrorState message={failedProjectRead.error} onRetry={() => void retryProjectRead()} pending={busy} /> : null}
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {strings.cancel}
        </button>
      </div>
    </BottomSheet>
  );
}
