import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, Task } from "@machbar/shared";
import { useNavigate } from "react-router-dom";
import { api, type ProjectWithActions, type CreationIntent } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { flattenTasks } from "../lib/taskHelpers";
import {
  appendTextBlock,
  parseWebShareTarget,
  shareTargetToCaptureDraft,
  shareTargetToSource,
  shareTargetToTextBlock,
  type WebShareTarget,
} from "../lib/shareTarget";
import {
  readRecentShareTargets,
  rememberShareTarget,
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

function optionForTask(task: Task, strings: Strings): ShareOption {
  const isReference = task.kind === "reference";
  return {
    key: `task:${task.id}`,
    kind: "task",
    taskKind: task.kind,
    id: task.id,
    title: task.title,
    subtitle: isReference
      ? task.projectTitle
        ? strings.materialDestination(task.projectTitle)
        : strings.materialLabel
      : task.projectTitle
        ? `${strings.task} · ${task.projectTitle}`
        : strings.task,
    notes: task.notes,
    dueDate: task.dueDate,
    revision: task.revision,
    projectId: task.projectId,
  };
}

function optionForProject(
  project: Project | ProjectWithActions,
  strings: Strings,
): ShareOption {
  return {
    key: `project:${project.id}`,
    kind: "project",
    id: project.id,
    title: project.title,
    subtitle: strings.project,
    notes: project.notes,
    dueDate: project.dueDate,
    revision: project.revision,
    projectId: project.id,
  };
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
  if (
    cleanTitle &&
    cleanSource.startsWith(cleanTitle) &&
    (cleanSource.length === cleanTitle.length ||
      /\s/.test(cleanSource[cleanTitle.length] ?? ""))
  ) {
    return cleanSource.slice(cleanTitle.length).trim();
  }
  return cleanSource;
}

function TargetRows({
  options,
  busyKey,
  selectedKey,
  onChoose,
}: {
  options: ShareOption[];
  busyKey: string | null;
  selectedKey: string | null;
  onChoose: (option: ShareOption) => void;
}) {
  const strings = useStrings();
  return (
    <div className="share-target-list">
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
  const { currentMemberId } = useIdentity();
  const { bump } = useRefresh();
  const { start: startIntake, pending: intakePending, error: intakeError } = useStartIntake();
  const captureDraft = useMemo(
    () => shareTargetToCaptureDraft(incoming, locale),
    [incoming, locale],
  );
  const [titleDraft, setTitleDraft] = useState(captureDraft.title);
  const [sourceDraft, setSourceDraft] = useState(() => shareTargetToSource(incoming));
  const calendarMetadata = useMemo(
    () => parseGoogleCalendarShare(incoming, { locale }),
    [incoming, locale],
  );
  const calendarDueDate = calendarMetadata?.dueDate ?? null;
  const formattedCalendarDueDate = calendarDueDate
    ? formatExactLocalDate(calendarDueDate, locale)
    : null;
  const [captureOpen, setCaptureOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<CompletedShare | null>(null);
  const [pendingConflict, setPendingConflict] = useState<ShareOption | null>(null);
  const [note, setNote] = useState("");
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null);
  const attachmentUploads = useRef(
    new Map<number, Promise<UploadedPaperlessAttachment>>(),
  );

  const projectsState = useAsync(() => api.getProjects(), []);
  const tasksState = useAsync(
    () => api.searchTasks({ kinds: ["action", "reference"] }),
    [],
  );
  const agendaState = useAsync(() => api.getAgenda(currentMemberId), [currentMemberId]);

  const allOptions = useMemo(
    () =>
      uniqueOptions([
        ...(projectsState.data ?? []).map((project) =>
          optionForProject(project, strings),
        ),
        ...(tasksState.data ?? []).map((task) => optionForTask(task, strings)),
      ]),
    [projectsState.data, strings, tasksState.data],
  );
  const optionByKey = useMemo(
    () => new Map(allOptions.map((option) => [option.key, option])),
    [allOptions],
  );
  const selectedTarget = selectedTargetKey
    ? optionByKey.get(selectedTargetKey) ?? null
    : null;
  const materialProjectId =
    selectedTarget?.kind === "project"
      ? selectedTarget.id
      : selectedTarget?.projectId ?? null;
  const materialProjectTitle =
    materialProjectId === null
      ? null
      : projectsState.data?.find((project) => project.id === materialProjectId)?.title ??
        (selectedTarget?.kind === "project" ? selectedTarget.title : null) ??
        null;
  const recentOptions = useMemo(
    () =>
      readRecentShareTargets()
        .map((target) => optionByKey.get(`${target.kind}:${target.id}`))
        .filter((option): option is ShareOption => option !== undefined),
    [optionByKey],
  );
  const todayOptions = useMemo(() => {
    const agenda = agendaState.data;
    if (!agenda) return [];
    const tasks = uniqueOptions(
      [
        ...agenda.planned,
        ...agenda.overdue,
        ...agenda.dueToday,
        ...agenda.dueSoon,
        ...(agenda.revisit ?? []),
        ...agenda.shared,
        ...agenda.unscheduled,
      ].flatMap((task) =>
        flattenTasks([task]).map((entry) => optionForTask(entry, strings)),
      ),
    );
    const projects = agenda.projects.map((entry) =>
      optionForProject(entry.project, strings),
    );
    const recentKeys = new Set(recentOptions.map((option) => option.key));
    return uniqueOptions([...projects, ...tasks]).filter(
      (option) => !recentKeys.has(option.key),
    );
  }, [agendaState.data, recentOptions, strings]);
  const searchOptions = useMemo(() => {
    const needle = fold(query.trim(), locale);
    if (!needle) return [];
    return allOptions.filter((option) =>
      fold(`${option.title} ${option.subtitle}`, locale).includes(needle),
    );
  }, [allOptions, locale, query]);

  const completeShare = (option: ShareOption) => {
    rememberShareTarget({
      kind: option.kind,
      id: option.id,
    } satisfies RecentShareTarget);
    bump();
    setCompleted({ kind: option.kind, id: option.id, title: option.title });
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
            selectedTarget?.kind === "task" &&
            selectedTarget.taskKind === "reference"
              ? selectedTarget.id
              : null,
        },
        creationIntent.current,
      );
      if (materialProjectId !== null) {
        rememberShareTarget({ kind: "project", id: materialProjectId });
      } else {
        rememberShareTarget({ kind: "task", id: task.id });
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

  const loading = projectsState.loading || tasksState.loading || agendaState.loading;
  const loadError = projectsState.error || tasksState.error || agendaState.error;
  const interactionsBusy = busyKey !== null || intakePending;
  const materialDestinationMessage = materialProjectTitle
    ? strings.shareMaterialInProject(materialProjectTitle)
    : strings.shareMaterialWithoutProject;

  return (
    <div className="share-page stack">
      <h1>{strings.shareWithMachbar}</h1>
      <section className="card stack share-preview">
        <label className="field">
          <span>{strings.title}</span>
          <input
            type="text"
            value={titleDraft}
            disabled={interactionsBusy}
            onChange={(event) => setTitleDraft(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{strings.shareSourceLabel}</span>
          <textarea
            rows={4}
            value={sourceDraft}
            placeholder={strings.shareSourcePlaceholder}
            disabled={interactionsBusy}
            onChange={(event) => setSourceDraft(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{strings.shareNoteLabel}</span>
          <textarea
            rows={3}
            value={note}
            placeholder={strings.shareNotePlaceholder}
            disabled={interactionsBusy}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        {formattedCalendarDueDate ? (
          <p className="share-preview-deadline">
            {strings.calendarDeadlinePreview(formattedCalendarDueDate)}
          </p>
        ) : null}
        {incoming.files.length > 0 ? (
          <p>{strings.sharedAttachments(incoming.files.length)}</p>
        ) : null}
      </section>
      {!pendingConflict ? (
        <section className="section stack" aria-labelledby="share-destinations-heading">
          <h2 className="section-title" id="share-destinations-heading">
            {strings.shareMaterialDestinationHeading}
          </h2>
          <button
            type="button"
            className="choice-chip"
            aria-pressed={selectedTargetKey === null}
            disabled={interactionsBusy}
            onClick={() => setSelectedTargetKey(null)}
          >
            {strings.shareWithoutProject}
          </button>
          <p className="text-muted">{materialDestinationMessage}</p>
          {recentOptions.length > 0 ? (
            <section className="section" aria-labelledby="share-recent-heading">
              <h3 className="section-title" id="share-recent-heading">
                {strings.recentDestinations}
              </h3>
              <TargetRows
                options={recentOptions}
                busyKey={interactionsBusy ? "busy" : null}
                selectedKey={selectedTargetKey}
                onChoose={(option) => setSelectedTargetKey(option.key)}
              />
            </section>
          ) : null}
          {todayOptions.length > 0 && !query.trim() ? (
            <section className="section" aria-labelledby="share-today-heading">
              <h3 className="section-title" id="share-today-heading">{strings.today}</h3>
              <TargetRows
                options={todayOptions}
                busyKey={interactionsBusy ? "busy" : null}
                selectedKey={selectedTargetKey}
                onChoose={(option) => setSelectedTargetKey(option.key)}
              />
            </section>
          ) : null}
          <label className="field">
            <span>{strings.searchShareTargets}</span>
            <input
              type="search"
              value={query}
              placeholder={strings.searchDestinationPlaceholder}
              disabled={interactionsBusy}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {query.trim() && searchOptions.length === 0 ? (
            <p className="text-muted">{strings.destinationSearchEmpty}</p>
          ) : null}
          {searchOptions.length > 0 ? (
            <TargetRows
              options={searchOptions}
              busyKey={interactionsBusy ? "busy" : null}
              selectedKey={selectedTargetKey}
              onChoose={(option) => setSelectedTargetKey(option.key)}
            />
          ) : null}
        </section>
      ) : null}

      {!pendingConflict && !captureOpen ? (
        <section className="card stack">
          <h2 className="section-title">{strings.shareActionHeading}</h2>
          <div className="stack">
            <p>{strings.shareMaterialActionHint} {materialDestinationMessage}</p>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={interactionsBusy || !titleDraft.trim()}
              onClick={() => void saveAsMaterial()}
            >
              {busyKey === "material"
                ? strings.shareSavingMaterial
                : strings.shareSaveAsMaterial}
            </button>
          </div>
          <div className="stack">
            <p>
              {selectedTarget
                ? strings.shareAppendActionHint
                : strings.shareAppendTargetHint}
            </p>
            <button
              type="button"
              className="btn btn-block"
              disabled={interactionsBusy || selectedTarget === null}
              onClick={() => {
                if (selectedTarget) appendTo(selectedTarget);
              }}
            >
              {busyKey === selectedTarget?.key
                ? strings.sharing
                : strings.shareAppendNotes}
            </button>
          </div>
          <div className="stack">
            <p>{strings.shareProcessActionHint}</p>
            <button
              type="button"
              className="btn btn-block"
              disabled={interactionsBusy}
              onClick={processShared}
            >
              {intakePending ? strings.intakeStarting : strings.intakeProcess}
            </button>
          </div>
        </section>
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

      {!pendingConflict && captureOpen ? (
        <section className="section share-capture" aria-labelledby="share-new-heading">
          <h2 className="section-title" id="share-new-heading">{strings.shareCaptureTask}</h2>
          <CaptureForm
            initialTitle={titleDraft}
            initialNotes={shareSourceWithoutTitle(titleDraft, sourceDraft)}
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
      ) : !pendingConflict ? (
        <button
          type="button"
          className="btn btn-block share-new-button"
          disabled={interactionsBusy}
          onClick={() => setCaptureOpen(true)}
        >
          {strings.shareCaptureTask}
        </button>
      ) : null}

      {error ? <p className="capture-error" role="alert">{error}</p> : null}
      {!pendingConflict && loading ? <LoadingState /> : null}
      {!pendingConflict && loadError ? (
        <ErrorState
          message={loadError}
          onRetry={() => {
            projectsState.reload();
            tasksState.reload();
            agendaState.reload();
          }}
        />
      ) : null}
    </div>
  );
}
