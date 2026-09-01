import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, Task } from "@machbar/shared";
import { useNavigate } from "react-router-dom";
import { api, type ProjectWithActions } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { flattenTasks } from "../lib/taskHelpers";
import {
  appendTextBlock,
  parseWebShareTarget,
  shareTargetToCaptureDraft,
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
  id: number;
  title: string;
  subtitle: string;
  notes: string;
  dueDate: string | null;
  revision: number;
}

interface CompletedShare {
  kind: "task" | "project";
  id: number;
  title: string;
}

function optionForTask(task: Task, strings: Strings): ShareOption {
  return {
    key: `task:${task.id}`,
    kind: "task",
    id: task.id,
    title: task.title,
    subtitle: task.projectTitle
      ? `${strings.task} · ${task.projectTitle}`
      : strings.task,
    notes: task.notes,
    dueDate: task.dueDate,
    revision: task.revision,
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

function TargetRows({
  options,
  busyKey,
  onChoose,
}: {
  options: ShareOption[];
  busyKey: string | null;
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
  const captureDraft = useMemo(
    () => shareTargetToCaptureDraft(incoming, locale),
    [incoming, locale],
  );
  const appendBlock = useMemo(() => shareTargetToTextBlock(incoming), [incoming]);
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
  const attachmentUploads = useRef(
    new Map<number, Promise<UploadedPaperlessAttachment>>(),
  );

  const projectsState = useAsync(() => api.getProjects(), []);
  const tasksState = useAsync(() => api.searchTasks({}), []);
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

  const resolveAppendBlock = async () =>
    appendTextBlock(appendBlock, await resolveAttachmentBlock());

  const reloadTargets = () => {
    projectsState.reload();
    tasksState.reload();
    agendaState.reload();
  };

  const applyTo = async (
    option: ShareOption,
    deadlineAction: "append" | "calendar",
  ) => {
    if (busyKey) return;
    setBusyKey(option.key);
    setError(null);
    try {
      const resolvedBlock = await resolveAppendBlock();
      if (deadlineAction === "calendar" && calendarDueDate) {
        const patch = {
          notes: appendTextBlock(option.notes, resolvedBlock),
          dueDate: calendarDueDate,
          expectedRevision: option.revision,
        };
        if (option.kind === "task") {
          await api.updateTask(option.id, patch);
        } else {
          await api.updateProject(option.id, patch);
        }
      } else if (option.kind === "task") {
        await api.appendTaskNotes(option.id, resolvedBlock);
      } else {
        await api.appendProjectNotes(option.id, resolvedBlock);
      }
      completeShare(option);
    } catch (cause) {
      if (isStaleWriteConflict(cause)) {
        bump();
        setPendingConflict(null);
        reloadTargets();
      }
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setBusyKey(null);
    }
  };

  const appendTo = (option: ShareOption) => {
    if (!calendarDueDate || option.dueDate === calendarDueDate) {
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

  const completeCapture = (result: CaptureResult) => {
    bump();
    setCompleted(
      result.kind === "task"
        ? { kind: "task", id: result.task.id, title: result.task.title }
        : { kind: "project", id: result.project.id, title: result.project.title },
    );
    setCaptureOpen(false);
    clearPendingShare();
  };

  if (completed) {
    return (
      <div className="share-page stack">
        <h1>{strings.shareWithMachbar}</h1>
        <div className="card stack" role="status">
          <strong>{strings.sharedWith(completed.title)}</strong>
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
            {strings.openSharedTarget}
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

  return (
    <div className="share-page stack">
      <h1>{strings.shareWithMachbar}</h1>
      <section className="card share-preview">
        <strong>{captureDraft.title}</strong>
        {formattedCalendarDueDate ? (
          <p className="share-preview-deadline">
            {strings.calendarDeadlinePreview(formattedCalendarDueDate)}
          </p>
        ) : null}
        {captureDraft.notes ? <p>{captureDraft.notes}</p> : null}
        {incoming.files.length > 0 ? (
          <p>{strings.sharedAttachments(incoming.files.length)}</p>
        ) : null}
      </section>

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
      ) : captureOpen ? (
        <section className="section share-capture" aria-labelledby="share-new-heading">
          <h2 className="section-title" id="share-new-heading">{strings.createNew}</h2>
          <CaptureForm
            initialTitle={captureDraft.title}
            initialNotes={captureDraft.notes}
            initialDueDate={calendarDueDate}
            showNotes
            showDueDate={calendarDueDate !== null}
            prepareNotes={async (notes) =>
              appendTextBlock(notes, await resolveAttachmentBlock())
            }
            onCancel={() => setCaptureOpen(false)}
            onCaptured={completeCapture}
          />
        </section>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-block share-new-button"
          onClick={() => setCaptureOpen(true)}
        >
          + {strings.newTask}
        </button>
      )}

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
      {!pendingConflict && !loading && !loadError ? (
        <>
          {recentOptions.length > 0 ? (
            <section className="section" aria-labelledby="share-recent-heading">
              <h2 className="section-title" id="share-recent-heading">
                {strings.recentDestinations}
              </h2>
              <TargetRows options={recentOptions} busyKey={busyKey} onChoose={appendTo} />
            </section>
          ) : null}
          {todayOptions.length > 0 && !query.trim() ? (
            <section className="section" aria-labelledby="share-today-heading">
              <h2 className="section-title" id="share-today-heading">{strings.today}</h2>
              <TargetRows options={todayOptions} busyKey={busyKey} onChoose={appendTo} />
            </section>
          ) : null}
          <section className="section">
            <label className="field">
              <span>{strings.searchShareTargets}</span>
              <input
                type="search"
                value={query}
                placeholder={strings.searchDestinationPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {query.trim() && searchOptions.length === 0 ? (
              <p className="text-muted">{strings.destinationSearchEmpty}</p>
            ) : null}
            {searchOptions.length > 0 ? (
              <TargetRows options={searchOptions} busyKey={busyKey} onChoose={appendTo} />
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
