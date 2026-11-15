import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, Task } from "@machbar/shared";
import { useNavigate } from "react-router-dom";
import { api, type ProjectWithActions, type CreationIntent } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRefresh } from "../lib/refresh";
import {
  appendTextBlock,
  parseWebShareTarget,
  shareTargetToCaptureDraft,
  shareTargetToSource,
  shareTargetToTextBlock,
  type WebShareTarget,
} from "../lib/shareTarget";
import {
  readRecentNoteTargets,
  readRecentMaterialTargets,
  rememberMaterialTarget,
  rememberNoteTarget,
  type RecentShareTarget,
} from "../lib/recentShareTargets";
import { useStrings } from "../lib/strings";
import type { Strings } from "../lib/strings";
import { CaptureForm, type CaptureResult } from "../components/CaptureForm";
import { ErrorState, LoadingState } from "../components/AsyncStates";
import { useLocale } from "../lib/locale";
import {
  isStaleWriteConflict,
  localizedErrorMessage,
} from "../lib/errorMessage";
import { parseGoogleCalendarShare } from "../lib/googleCalendarShare";
import { useStartIntake } from "../lib/useStartIntake";
import { formatExactLocalDate } from "../lib/relativeDate";
import {
  deletePendingShareTarget,
  readPendingShareTarget,
} from "../lib/pendingShareTarget";
import {
  paperlessAttachmentBlock,
  uploadPaperlessFile,
  type UploadedPaperlessAttachment,
} from "../lib/paperlessAttachments";

interface ShareOption {
  key: string;
  kind: "task" | "project";
  taskKind?: "action" | "reference";
  id: number;
  title: string;
  subtitle: string;
  notes: string;
  path: string;
  dueDate: string | null;
  revision: number;
  projectId: number | null;
}

interface CompletedShare {
  kind: "task" | "project";
  id: number;
  title: string;
  material?: boolean;
}

function optionForTask(
  task: Task,
  strings: Strings,
  tasksById: Map<number, Task>,
  projectsById: Map<number, Project | ProjectWithActions>,
): ShareOption {
  const isReference = task.kind === "reference";
  const ancestors: string[] = [];
  const seen = new Set([task.id]);
  let parentId = task.parentTaskId;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = tasksById.get(parentId);
    if (!parent) break;
    ancestors.unshift(parent.title);
    parentId = parent.parentTaskId;
  }
  const project = task.projectId === null ? undefined : projectsById.get(task.projectId);
  const projectTitle = project
    ? projectPath(project, projectsById)
    : task.projectTitle ?? null;
  const path = [projectTitle, ...ancestors, task.title]
    .filter((part): part is string => Boolean(part))
    .join(" › ");
  return {
    key: `task:${task.id}`,
    kind: "task",
    taskKind: task.kind,
    id: task.id,
    title: task.title,
    subtitle: isReference
      ? path
      : projectTitle
        ? `${strings.task} · ${projectTitle}`
        : strings.task,
    notes: task.notes,
    path,
    dueDate: task.dueDate,
    revision: task.revision,
    projectId: task.projectId,
  };
}

function optionForProject(
  project: Project | ProjectWithActions,
  strings: Strings,
  projectsById: Map<number, Project | ProjectWithActions>,
): ShareOption {
  const path = projectPath(project, projectsById);
  return {
    key: `project:${project.id}`,
    kind: "project",
    id: project.id,
    title: project.title,
    subtitle: path === project.title ? strings.project : path,
    notes: project.notes,
    path,
    dueDate: project.dueDate,
    revision: project.revision,
    projectId: project.id,
  };
}

function projectPath(
  project: Project | ProjectWithActions,
  projectsById: Map<number, Project | ProjectWithActions>,
): string {
  const ancestors: string[] = [];
  const seen = new Set([project.id]);
  let parentId = project.parentId;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = projectsById.get(parentId);
    if (!parent) break;
    ancestors.unshift(parent.title);
    parentId = parent.parentId;
  }
  return [...ancestors, project.title].join(" › ");
}

function fold(value: string, locale: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase(locale);
}

function uniqueOptions(options: ShareOption[]): ShareOption[] {
  return [...new Map(options.map((option) => [option.key, option])).values()];
}

function shareDraftBlock(title: string, source: string): string {
  return appendTextBlock(title, shareSourceWithoutTitle(title, source));
}

function shareSourceWithoutTitle(title: string, source: string): string {
  const cleanTitle = title.trim();
  const cleanSource = source.trim();
  if (!cleanTitle) return cleanSource;
  if (cleanSource === cleanTitle) return "";
  const lineBreak = cleanSource.indexOf("\n");
  if (lineBreak >= 0 && cleanSource.slice(0, lineBreak).trim() === cleanTitle) {
    return cleanSource.slice(lineBreak + 1).trim();
  }
  return cleanSource;
}

function shareSourcePreview(source: string, strings: Strings): string {
  const url = source.match(/https?:\/\/[^\s<>"`]+/i)?.[0];
  if (url) {
    try {
      return new URL(url.replace(/[.,!?;:]+$/, "")).hostname;
    } catch {
      // Fall back to the shared text when the URL is incomplete.
    }
  }
  const compact = source.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 119).trimEnd()}…` : compact ||
    strings.sharedContent;
}

function TargetRows({
  options,
  busyKey,
  selectedKey,
  compact = false,
  onChoose,
}: {
  options: ShareOption[];
  busyKey: string | null;
  selectedKey: string | null;
  compact?: boolean;
  onChoose: (option: ShareOption) => void;
}) {
  const strings = useStrings();
  return (
    <div className={`share-target-list${compact ? " share-target-list-compact" : ""}`}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className="destination-row"
          aria-pressed={selectedKey === option.key}
          disabled={busyKey !== null}
          onClick={() => onChoose(option)}
        >
          <span className="destination-row-title">{option.title}</span>
          <span className="destination-row-subtitle">
            {busyKey === option.key ? strings.sharing : option.subtitle}
          </span>
        </button>
      ))}
    </div>
  );
}

export function SharePage() {
  const strings = useStrings();
  const navigate = useNavigate();
  const [pendingId] = useState(
    () => new URLSearchParams(window.location.search).get("shareId"),
  );
  const [shareError] = useState(
    () => new URLSearchParams(window.location.search).get("shareError"),
  );
  const [incoming, setIncoming] = useState<WebShareTarget | null>(() =>
    pendingId ? null : parseWebShareTarget(window.location.search),
  );
  const [pendingError, setPendingError] = useState<string | null>(() =>
    shareError ? strings.sharedContentUnavailable : null,
  );

  useEffect(() => {
    if (pendingId) {
      readPendingShareTarget(pendingId)
        .then((target) => {
          if (target) setIncoming(target);
          else setPendingError(strings.noSharedContent);
        })
        .catch((cause: unknown) =>
          setPendingError(localizedErrorMessage(cause, strings)),
        );
      return;
    }
    if (!window.location.search) return;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.hash}`,
    );
  }, [pendingId, shareError, strings]);

  if (pendingError) {
    return (
      <div className="share-page stack">
        <h1>{strings.shareWithMachbar}</h1>
        <div className="card stack" role="alert">
          <p>{pendingError}</p>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => navigate("/today")}
          >
            {strings.toMachbar}
          </button>
        </div>
      </div>
    );
  }
  if (!incoming) return <LoadingState />;

  const appendBlock = shareTargetToTextBlock(incoming);

  if (!appendBlock && incoming.files.length === 0) {
    return (
      <div className="share-page stack">
        <h1>{strings.shareWithMachbar}</h1>
        <div className="card stack" role="alert">
          <p>{strings.noSharedContent}</p>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => navigate("/today")}
          >
            {strings.toMachbar}
          </button>
        </div>
      </div>
    );
  }

  return <SharePageContent incoming={incoming} pendingId={pendingId} />;
}

function SharePageContent({
  incoming,
  pendingId,
}: {
  incoming: WebShareTarget;
  pendingId: string | null;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const { bump } = useRefresh();
  const { start: startIntake, pending: intakePending, error: intakeError } = useStartIntake();
  const captureDraft = useMemo(
    () => shareTargetToCaptureDraft(incoming, locale),
    [incoming, locale],
  );
  const [titleDraft, setTitleDraft] = useState(captureDraft.title);
  const [sourceDraft, setSourceDraft] = useState(() => shareTargetToSource(incoming));
  const [titleEditDraft, setTitleEditDraft] = useState(captureDraft.title);
  const [sourceEditDraft, setSourceEditDraft] = useState(() => shareTargetToSource(incoming));
  const calendarMetadata = useMemo(
    () => parseGoogleCalendarShare(incoming, { locale }),
    [incoming, locale],
  );
  const calendarDueDate = calendarMetadata?.dueDate ?? null;
  const formattedCalendarDueDate = calendarDueDate
    ? formatExactLocalDate(calendarDueDate, locale)
    : null;
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureVisited, setCaptureVisited] = useState(false);
  const [noteEditing, setNoteEditing] = useState(false);
  const [contentEditing, setContentEditing] = useState(false);
  const [materialSearchOpen, setMaterialSearchOpen] = useState(false);
  const [noteSearchOpen, setNoteSearchOpen] = useState(false);
  const materialSearchInput = useRef<HTMLInputElement>(null);
  const noteSearchInput = useRef<HTMLInputElement>(null);
  const contentEditButton = useRef<HTMLButtonElement>(null);
  const titleEditInput = useRef<HTMLInputElement>(null);
  const annotationEditButton = useRef<HTMLButtonElement>(null);
  const annotationEditInput = useRef<HTMLTextAreaElement>(null);
  const wasContentEditing = useRef(false);
  const wasNoteEditing = useRef(false);
  const [materialQuery, setMaterialQuery] = useState("");
  const [noteQuery, setNoteQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<CompletedShare | null>(null);
  const [pendingConflict, setPendingConflict] = useState<ShareOption | null>(null);
  const [note, setNote] = useState("");
  const [noteEditDraft, setNoteEditDraft] = useState("");
  const [selectedMaterialKey, setSelectedMaterialKey] = useState<string | null>(null);
  const [selectedNoteKey, setSelectedNoteKey] = useState<string | null>(null);
  const attachmentUploads = useRef(
    new Map<number, Promise<UploadedPaperlessAttachment>>(),
  );

  const projectsState = useAsync(() => api.getProjects(), []);
  const tasksState = useAsync(
    () => api.searchTasks({ kinds: ["action", "reference"] }),
    [],
  );
  useEffect(() => {
    if (materialSearchOpen) materialSearchInput.current?.focus();
  }, [materialSearchOpen]);
  useEffect(() => {
    if (noteSearchOpen) noteSearchInput.current?.focus();
  }, [noteSearchOpen]);
  useEffect(() => {
    if (contentEditing) titleEditInput.current?.focus();
    else if (wasContentEditing.current) contentEditButton.current?.focus();
    wasContentEditing.current = contentEditing;
  }, [contentEditing]);
  useEffect(() => {
    if (noteEditing) annotationEditInput.current?.focus();
    else if (wasNoteEditing.current) annotationEditButton.current?.focus();
    wasNoteEditing.current = noteEditing;
  }, [noteEditing]);
  const tasksById = useMemo(
    () => new Map((tasksState.data ?? []).map((task) => [task.id, task])),
    [tasksState.data],
  );
  const projectsById = useMemo(
    () => new Map((projectsState.data ?? []).map((project) => [project.id, project])),
    [projectsState.data],
  );

  const allOptions = useMemo(
    () =>
      uniqueOptions([
        ...(projectsState.data ?? []).map((project) =>
          optionForProject(project, strings, projectsById),
        ),
        ...(tasksState.data ?? []).map((task) =>
          optionForTask(task, strings, tasksById, projectsById),
        ),
      ]),
    [projectsState.data, projectsById, strings, tasksById, tasksState.data],
  );
  const optionByKey = useMemo(
    () => new Map(allOptions.map((option) => [option.key, option])),
    [allOptions],
  );
  const materialOptions = useMemo(
    () => allOptions.filter((option) => option.kind === "project" || option.taskKind === "reference"),
    [allOptions],
  );
  const materialOptionByKey = useMemo(
    () => new Map(materialOptions.map((option) => [option.key, option])),
    [materialOptions],
  );
  const selectedMaterialTarget = selectedMaterialKey
    ? materialOptionByKey.get(selectedMaterialKey) ?? null
    : null;
  const materialProjectId =
    selectedMaterialTarget?.kind === "project"
      ? selectedMaterialTarget.id
      : selectedMaterialTarget?.projectId ?? null;
  const recentMaterialOptions = useMemo(
    () =>
      readRecentMaterialTargets()
        .slice(0, 3)
        .map((target) => materialOptionByKey.get(`${target.kind}:${target.id}`))
        .filter((option): option is ShareOption => option !== undefined),
    [materialOptionByKey],
  );
  const recentNoteOptions = useMemo(
    () =>
      readRecentNoteTargets()
        .map((target) => optionByKey.get(`${target.kind}:${target.id}`))
        .filter((option): option is ShareOption => option !== undefined),
    [optionByKey],
  );
  const selectedNoteTarget = selectedNoteKey
    ? optionByKey.get(selectedNoteKey) ?? null
    : null;
  const materialSearchOptions = useMemo(() => {
    const needle = fold(materialQuery.trim(), locale);
    if (!needle) return [];
    return materialOptions.filter((option) =>
      fold(`${option.title} ${option.path}`, locale).includes(needle),
    );
  }, [locale, materialOptions, materialQuery]);
  const noteSearchOptions = useMemo(() => {
    const needle = fold(noteQuery.trim(), locale);
    if (!needle) return [];
    return allOptions.filter((option) =>
      fold(`${option.title} ${option.path}`, locale).includes(needle),
    );
  }, [allOptions, locale, noteQuery]);

  const completeShare = (option: ShareOption) => {
    rememberNoteTarget({
      kind: option.kind,
      id: option.id,
    } satisfies RecentShareTarget);
    bump();
    setCompleted({
      kind: option.kind,
      id: option.id,
      title: option.kind === "task" && option.taskKind === "reference"
        ? option.path
        : option.title,
    });
    setPendingConflict(null);
    clearPendingShare();
  };

  const clearPendingShare = () => {
    if (!pendingId) return;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.hash}`,
    );
    void deletePendingShareTarget(pendingId).catch((cause: unknown) => {
      console.error("Could not remove the completed pending share.", cause);
    });
  };

  const resolveAttachmentBlock = async () => {
    const uploads = await Promise.all(
      incoming.files.map((file, index) => {
        let upload = attachmentUploads.current.get(index);
        if (!upload) {
          upload = uploadPaperlessFile(file).catch((cause: unknown) => {
            attachmentUploads.current.delete(index);
            throw cause;
          });
          attachmentUploads.current.set(index, upload);
        }
        return upload;
      }),
    );
    return paperlessAttachmentBlock(uploads);
  };

  const shareContentText = () =>
    shareDraftBlock(
      incoming.title || incoming.text || titleDraft.trim() !== captureDraft.title
        ? titleDraft
        : "",
      sourceDraft,
    );

  const resolveContentBlock = async (includeTitle: boolean) => {
    const text = includeTitle ? shareContentText() : sourceDraft;
    const withAttachments = appendTextBlock(
      text,
      await resolveAttachmentBlock(),
    );
    return appendTextBlock(withAttachments, note.trim());
  };

  const creationIntent = useRef<CreationIntent>({});
  const saveAsMaterial = async () => {
    if (busyKey || intakePending) return;
    if (selectedMaterialKey !== null && !selectedMaterialTarget) {
      setError(strings.shareDestinationUnavailable);
      return;
    }
    setBusyKey("material");
    setError(null);
    try {
      const task = await api.createTask(
        {
          kind: "reference",
          title: titleDraft.trim(),
          notes: await resolveContentBlock(false),
          projectId: materialProjectId,
          parentTaskId:
            selectedMaterialTarget?.kind === "task" &&
            selectedMaterialTarget.taskKind === "reference"
              ? selectedMaterialTarget.id
              : null,
        },
        creationIntent.current,
      );
      if (selectedMaterialTarget) {
        rememberMaterialTarget({
          kind: selectedMaterialTarget.kind,
          id: selectedMaterialTarget.id,
        });
      }
      bump();
      setCompleted({
        kind: "task",
        id: task.id,
        title: task.title,
        material: true,
      });
      setPendingConflict(null);
      clearPendingShare();
    } catch (cause) {
      if (isStaleWriteConflict(cause)) bump();
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setBusyKey(null);
    }
  };

  const applyTo = async (
    option: ShareOption,
    deadlineAction: "append" | "calendar",
  ) => {
    if (busyKey || intakePending) return;
    setBusyKey(option.key);
    setError(null);
    try {
      const resolvedBlock = await resolveContentBlock(true);
      if (
        deadlineAction === "calendar" &&
        calendarDueDate &&
        option.kind === "task" &&
        option.taskKind !== "reference"
      ) {
        await api.updateTask(option.id, {
          notes: appendTextBlock(option.notes, resolvedBlock),
          dueDate: calendarDueDate,
          expectedRevision: option.revision,
        });
      } else if (option.kind === "project") {
        await api.appendProjectNotes(option.id, resolvedBlock);
      } else {
        await api.appendTaskNotes(option.id, resolvedBlock);
      }
      completeShare(option);
    } catch (cause) {
      if (isStaleWriteConflict(cause)) {
        bump();
        setPendingConflict(null);
      }
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setBusyKey(null);
    }
  };

  const appendTo = (option: ShareOption) => {
    if (
      option.kind === "project" ||
      option.taskKind === "reference" ||
      !calendarDueDate ||
      option.dueDate === calendarDueDate
    ) {
      void applyTo(option, "append");
      return;
    }
    if (option.dueDate === null) {
      void applyTo(option, "calendar");
      return;
    }
    setError(null);
    setPendingConflict(option);
  };

  const processShared = () => {
    if (busyKey || intakePending) return;
    const text = appendTextBlock(
      shareContentText(),
      note.trim(),
    );
    void startIntake({ text, files: incoming.files })
      .then(() => {
        clearPendingShare();
      })
      .catch(() => undefined);
  };

  const completeCapture = (result: CaptureResult) => {
    bump();
    setCompleted({ kind: "task", id: result.task.id, title: result.task.title });
    setCaptureOpen(false);
    clearPendingShare();
  };

  if (completed) {
    return (
      <div className="share-page stack">
        <h1>{strings.shareWithMachbar}</h1>
        <div className="card stack" role="status">
          <strong>
            {completed.material
              ? strings.materialSaved(completed.title)
              : strings.sharedWith(completed.title)}
          </strong>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() =>
              navigate(
                completed.kind === "task"
                  ? `/tasks/${completed.id}`
                  : `/projects/${completed.id}`,
              )
            }
          >
            {completed.material ? strings.viewMaterial : strings.openSharedTarget}
          </button>
          <button type="button" className="btn btn-block" onClick={() => navigate("/today")}>
            {strings.done}
          </button>
        </div>
      </div>
    );
  }

  const loading = projectsState.loading || tasksState.loading;
  const loadError = projectsState.error || tasksState.error;
  const interactionsBusy = busyKey !== null || intakePending;
  const captureControlsDisabled = interactionsBusy || captureOpen;
  const editing = contentEditing || noteEditing;
  const materialTargetUnavailable =
    selectedMaterialKey !== null && selectedMaterialTarget === null;
  const noteTargetUnavailable = selectedNoteKey !== null && selectedNoteTarget === null;
  const sourcePreview = shareSourcePreview(sourceDraft, strings);

  return (
    <div className="share-page stack">
      <h1>{strings.shareWithMachbar}</h1>
      <section className="card stack share-preview">
        <div className="share-preview-content">
          <h2 className="share-preview-title">{titleDraft || strings.sharedContent}</h2>
          <p className="share-source-preview">{sourcePreview}</p>
        </div>
        {incoming.files.length > 0 ? (
          <p className="share-preview-attachments">
            {strings.sharedAttachments(incoming.files.length)}
          </p>
        ) : null}
        {formattedCalendarDueDate ? (
          <p className="share-preview-deadline">
            {strings.calendarDeadlinePreview(formattedCalendarDueDate)}
          </p>
        ) : null}
        <button
          ref={contentEditButton}
          type="button"
          className="btn share-preview-toggle"
          aria-expanded={contentEditing}
          aria-controls="share-content-editor"
          disabled={captureControlsDisabled}
          onClick={() => {
            if (contentEditing) {
              titleEditInput.current?.focus();
            } else {
              setTitleEditDraft(titleDraft);
              setSourceEditDraft(sourceDraft);
              setContentEditing(true);
            }
          }}
        >
          {strings.shareEditContent}
        </button>
        {contentEditing ? (
          <div id="share-content-editor" className="stack share-editor">
            <label className="field">
              <span>{strings.title}</span>
              <input
                ref={titleEditInput}
                type="text"
                value={titleEditDraft}
                disabled={captureControlsDisabled}
                onChange={(event) => setTitleEditDraft(event.target.value)}
              />
            </label>
            <label className="field">
              <span>{strings.shareSourceLabel}</span>
              <textarea
                rows={4}
                value={sourceEditDraft}
                placeholder={strings.shareSourcePlaceholder}
                disabled={captureControlsDisabled}
                onChange={(event) => setSourceEditDraft(event.target.value)}
              />
            </label>
            <div className="share-editor-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={captureControlsDisabled}
                onClick={() => {
                  setTitleDraft(titleEditDraft);
                  setSourceDraft(sourceEditDraft);
                  setContentEditing(false);
                }}
              >
                {strings.shareSaveEdits}
              </button>
              <button
                type="button"
                className="btn"
                disabled={captureControlsDisabled}
                onClick={() => setContentEditing(false)}
              >
                {strings.shareCancelEdits}
              </button>
            </div>
          </div>
        ) : null}
        <button
          ref={annotationEditButton}
          type="button"
          className="btn share-preview-toggle"
          aria-expanded={noteEditing}
          aria-controls="share-annotation-editor"
          disabled={captureControlsDisabled}
          onClick={() => {
            if (noteEditing) {
              annotationEditInput.current?.focus();
            } else {
              setNoteEditDraft(note);
              setNoteEditing(true);
            }
          }}
        >
          {note.trim() ? strings.shareEditAnnotation : strings.shareAddAnnotation}
        </button>
        {noteEditing ? (
          <div id="share-annotation-editor" className="stack share-editor">
            <label className="field">
              <span>{strings.shareNoteLabel}</span>
              <textarea
                ref={annotationEditInput}
                rows={2}
                value={noteEditDraft}
                placeholder={strings.shareNotePlaceholder}
                disabled={captureControlsDisabled}
                onChange={(event) => setNoteEditDraft(event.target.value)}
              />
            </label>
            <div className="share-editor-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={captureControlsDisabled}
                onClick={() => {
                  setNote(noteEditDraft);
                  setNoteEditing(false);
                }}
              >
                {strings.shareSaveEdits}
              </button>
              <button
                type="button"
                className="btn"
                disabled={captureControlsDisabled}
                onClick={() => setNoteEditing(false)}
              >
                {strings.shareCancelEdits}
              </button>
            </div>
          </div>
        ) : (
          note.trim() ? (
            <p className="share-annotation-preview">{note.replace(/\s+/g, " ").trim()}</p>
          ) : null
        )}
      </section>
      {!pendingConflict ? (
        <>
          <section
            className="section stack share-material-destination"
            aria-labelledby="share-destinations-heading"
          >
            <h2 className="section-title" id="share-destinations-heading">
              {strings.shareMaterialDestinationHeading}
            </h2>
            <p className="share-current-destination">
              {strings.shareCurrentDestination}:{" "}
              <strong>
                {materialTargetUnavailable
                  ? strings.shareDestinationUnavailable
                  : selectedMaterialTarget?.path ?? strings.shareWithoutProject}
              </strong>
            </p>
            {materialTargetUnavailable ? (
              <p className="capture-error" role="alert">
                {strings.shareDestinationUnavailable}
              </p>
            ) : null}
            <button
              type="button"
              className="choice-chip"
              aria-pressed={selectedMaterialKey === null}
              disabled={captureControlsDisabled || editing || loading}
              onClick={() => setSelectedMaterialKey(null)}
            >
              {strings.shareWithoutProject}
            </button>
            {recentMaterialOptions.length > 0 ? (
              <section className="share-recent-section" aria-labelledby="share-recent-heading">
                <h3 className="section-title" id="share-recent-heading">
                  {strings.recentDestinations}
                </h3>
                <TargetRows
                  options={recentMaterialOptions}
                  compact
                  busyKey={captureControlsDisabled || editing || loading ? "busy" : null}
                  selectedKey={selectedMaterialKey}
                  onChoose={(option) => setSelectedMaterialKey(option.key)}
                />
              </section>
            ) : null}
            <button
              type="button"
              className="btn share-search-toggle"
              aria-expanded={materialSearchOpen}
              aria-controls="share-material-search"
              disabled={captureControlsDisabled || editing || loading}
              onClick={() => setMaterialSearchOpen((open) => !open)}
            >
              {strings.shareSearchDestination}
            </button>
            {materialSearchOpen ? (
              <div id="share-material-search" className="stack share-search-panel">
                <label className="field">
                  <span>{strings.searchShareTargets}</span>
                  <input
                    ref={materialSearchInput}
                    type="search"
                    value={materialQuery}
                    placeholder={strings.searchDestinationPlaceholder}
                    disabled={captureControlsDisabled || editing}
                    onChange={(event) => setMaterialQuery(event.target.value)}
                  />
                </label>
                {materialQuery.trim() && materialSearchOptions.length === 0 ? (
                  <p className="text-muted">{strings.destinationSearchEmpty}</p>
                ) : null}
                {materialSearchOptions.length > 0 ? (
                  <TargetRows
                    options={materialSearchOptions}
                    busyKey={captureControlsDisabled || editing ? "busy" : null}
                    selectedKey={selectedMaterialKey}
                    onChoose={(option) => setSelectedMaterialKey(option.key)}
                  />
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-block share-save-material"
              disabled={
                captureControlsDisabled ||
                loading ||
                editing ||
                !titleDraft.trim() ||
                materialTargetUnavailable
              }
              onClick={() => void saveAsMaterial()}
            >
              {busyKey === "material"
                ? strings.shareSavingMaterial
                : strings.shareSaveAsMaterial}
            </button>
          </section>

          <details className="share-more-actions">
            <summary>
              <span>{strings.shareMoreActions}</span>
              <span className="share-more-hint">{strings.shareMoreActionsHint}</span>
            </summary>
            <div className="stack share-more-content">
              <section className="stack share-note-destination" aria-labelledby="share-note-heading">
                <h2 className="section-title" id="share-note-heading">
                  {strings.shareNoteTargetsHeading}
                </h2>
                <p>
                  {selectedNoteTarget
                    ? strings.shareAppendActionHint
                    : strings.shareAppendTargetHint}
                </p>
                {noteTargetUnavailable ? (
                  <p className="capture-error" role="alert">
                    {strings.shareDestinationUnavailable}
                  </p>
                ) : null}
                {recentNoteOptions.length > 0 ? (
                  <TargetRows
                    options={recentNoteOptions}
                    compact
                    busyKey={captureControlsDisabled || editing || loading ? "busy" : null}
                    selectedKey={selectedNoteKey}
                    onChoose={(option) => setSelectedNoteKey(option.key)}
                  />
                ) : null}
                <button
                  type="button"
                  className="btn share-search-toggle"
                  aria-expanded={noteSearchOpen}
                  aria-controls="share-note-search"
                  disabled={captureControlsDisabled || editing || loading}
                  onClick={() => setNoteSearchOpen((open) => !open)}
                >
                  {strings.shareSearchNoteDestination}
                </button>
                {noteSearchOpen ? (
                  <div id="share-note-search" className="stack share-search-panel">
                    <label className="field">
                      <span>{strings.shareSearchNoteTargets}</span>
                      <input
                        ref={noteSearchInput}
                        type="search"
                        aria-label={strings.shareSearchNoteTargets}
                        value={noteQuery}
                        placeholder={strings.searchDestinationPlaceholder}
                        disabled={captureControlsDisabled || editing}
                        onChange={(event) => setNoteQuery(event.target.value)}
                      />
                    </label>
                    {noteQuery.trim() && noteSearchOptions.length === 0 ? (
                      <p className="text-muted">{strings.destinationSearchEmpty}</p>
                    ) : null}
                    {noteSearchOptions.length > 0 ? (
                      <TargetRows
                        options={noteSearchOptions}
                        busyKey={captureControlsDisabled || editing ? "busy" : null}
                        selectedKey={selectedNoteKey}
                        onChoose={(option) => setSelectedNoteKey(option.key)}
                      />
                    ) : null}
                  </div>
                ) : null}
                <button
                  type="button"
                  className="btn btn-block"
                  disabled={
                    captureControlsDisabled ||
                    loading ||
                    editing ||
                    !selectedNoteTarget ||
                    noteTargetUnavailable
                  }
                  onClick={() => {
                    if (selectedNoteTarget) appendTo(selectedNoteTarget);
                  }}
                >
                  {busyKey === selectedNoteTarget?.key
                    ? strings.sharing
                    : selectedNoteTarget
                      ? strings.shareAppendToDestination(selectedNoteTarget.path)
                      : strings.shareAppendNotes}
                </button>
              </section>
              <button
                type="button"
                className="btn btn-block"
                disabled={captureControlsDisabled || loading || editing}
                onClick={() => {
                  setCaptureVisited(true);
                  setCaptureOpen(true);
                }}
              >
                {strings.shareCaptureTask}
              </button>
              <button
                type="button"
                className="btn btn-block"
                disabled={captureControlsDisabled || editing}
                onClick={processShared}
              >
                {intakePending ? strings.intakeStarting : strings.shareProcessWithAi}
              </button>
            </div>
            {captureVisited ? (
              <section
                hidden={!captureOpen}
                className="section share-capture"
                aria-labelledby="share-new-heading"
              >
                <h2 className="section-title" id="share-new-heading">{strings.shareCaptureTask}</h2>
                <CaptureForm
                  initialTitle={titleDraft}
                  initialNotes={sourceDraft}
                  initialDueDate={calendarDueDate}
                  showNotes
                  showDueDate={calendarDueDate !== null}
                  pendingFiles={incoming.files}
                  prepareNotes={async (base) =>
                    appendTextBlock(
                      appendTextBlock(base, await resolveAttachmentBlock()),
                      note.trim(),
                    )
                  }
                  onCancel={() => setCaptureOpen(false)}
                  onCaptured={completeCapture}
                />
              </section>
            ) : null}
          </details>
        </>
      ) : null}
      {intakeError ? <p className="capture-error" role="alert">{intakeError}</p> : null}

      {pendingConflict && formattedCalendarDueDate ? (
        <section className="card stack share-deadline-conflict" role="alert">
          <p>
            {strings.calendarDeadlineConflict(
              pendingConflict.title,
              formatExactLocalDate(pendingConflict.dueDate ?? "", locale) ??
                pendingConflict.dueDate ??
                "",
              formattedCalendarDueDate,
            )}
          </p>
          <div className="stack">
            <button
              type="button"
              className="btn btn-block"
              disabled={busyKey !== null}
              onClick={() => void applyTo(pendingConflict, "append")}
            >
              {strings.keepExistingDeadline}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={busyKey !== null}
              onClick={() => void applyTo(pendingConflict, "calendar")}
            >
              {strings.useCalendarDeadline(formattedCalendarDueDate)}
            </button>
          </div>
        </section>
      ) : null}
      {error ? <p className="capture-error" role="alert">{error}</p> : null}
      {!pendingConflict && loading ? <LoadingState /> : null}
      {!pendingConflict && loadError ? (
        <ErrorState
          message={loadError}
          onRetry={() => {
            projectsState.reload();
            tasksState.reload();
          }}
        />
      ) : null}
    </div>
  );
}
