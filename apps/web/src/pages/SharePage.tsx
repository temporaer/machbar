import { useEffect, useMemo, useState } from "react";
import type { Project, Task } from "@machbar/shared";
import { useNavigate } from "react-router-dom";
import { api, type ProjectWithActions } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useRefresh } from "../lib/refresh";
import { flattenTasks } from "../lib/taskHelpers";
import {
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
import { localizedErrorMessage } from "../lib/errorMessage";

interface ShareOption {
  key: string;
  kind: "task" | "project";
  id: number;
  title: string;
  subtitle: string;
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
  const [incoming] = useState(() => parseWebShareTarget(window.location.search));
  const appendBlock = useMemo(() => shareTargetToTextBlock(incoming), [incoming]);

  useEffect(() => {
    if (!window.location.search) return;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.hash}`,
    );
  }, []);

  if (!appendBlock) {
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

  return <SharePageContent incoming={incoming} />;
}

function SharePageContent({ incoming }: { incoming: WebShareTarget }) {
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
  const [captureOpen, setCaptureOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<CompletedShare | null>(null);

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
        ...agenda.followUp,
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

  const appendTo = async (option: ShareOption) => {
    if (!appendBlock || busyKey) return;
    setBusyKey(option.key);
    setError(null);
    try {
      if (option.kind === "task") {
        await api.appendTaskNotes(option.id, appendBlock);
      } else {
        await api.appendProjectNotes(option.id, appendBlock);
      }
      rememberShareTarget({ kind: option.kind, id: option.id } satisfies RecentShareTarget);
      bump();
      setCompleted({ kind: option.kind, id: option.id, title: option.title });
    } catch (cause) {
      setError(localizedErrorMessage(cause, strings));
    } finally {
      setBusyKey(null);
    }
  };

  const completeCapture = (result: CaptureResult) => {
    bump();
    setCompleted(
      result.kind === "task"
        ? { kind: "task", id: result.task.id, title: result.task.title }
        : { kind: "project", id: result.project.id, title: result.project.title },
    );
    setCaptureOpen(false);
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
        {captureDraft.notes ? <p>{captureDraft.notes}</p> : null}
      </section>

      {captureOpen ? (
        <section className="section share-capture" aria-labelledby="share-new-heading">
          <h2 className="section-title" id="share-new-heading">{strings.createNew}</h2>
          <CaptureForm
            initialTitle={captureDraft.title}
            initialNotes={captureDraft.notes}
            showNotes
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
      {loading ? <LoadingState /> : null}
      {loadError ? (
        <ErrorState
          message={loadError}
          onRetry={() => {
            projectsState.reload();
            tasksState.reload();
            agendaState.reload();
          }}
        />
      ) : null}
      {!loading && !loadError ? (
        <>
          {recentOptions.length > 0 ? (
            <section className="section" aria-labelledby="share-recent-heading">
              <h2 className="section-title" id="share-recent-heading">
                {strings.recentDestinations}
              </h2>
              <TargetRows options={recentOptions} busyKey={busyKey} onChoose={(option) => void appendTo(option)} />
            </section>
          ) : null}
          {todayOptions.length > 0 && !query.trim() ? (
            <section className="section" aria-labelledby="share-today-heading">
              <h2 className="section-title" id="share-today-heading">{strings.today}</h2>
              <TargetRows options={todayOptions} busyKey={busyKey} onChoose={(option) => void appendTo(option)} />
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
              <TargetRows options={searchOptions} busyKey={busyKey} onChoose={(option) => void appendTo(option)} />
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
