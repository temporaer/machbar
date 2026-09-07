import { Link, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState, type DragEvent } from "react";
import type { Member } from "@machbar/shared";
import { api, type AgendaScope, type WeekAgendaResponse, type WeekPlanningItem } from "../lib/api";
import { addIsoCalendarDays, toIsoCalendarDate } from "../lib/naturalDate";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useStrings } from "../lib/strings";
import { useLocale } from "../lib/locale";
import { ErrorState, LoadingState } from "../components/AsyncStates";
import { PageHeader } from "../components/PageHeader";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { WorkItemKeyboardNavMount } from "../components/WorkItemKeyboardNavMount";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { HumanDateInput } from "../components/HumanDateInput";
import { TaskCardTags } from "../components/TaskCardTags";
import { MemberAvatar } from "../components/MemberAvatar";
import { formatDate } from "../lib/format";
import { QuickAdd } from "../components/QuickAdd";

function weekStart(date: Date): string {
  const copy = new Date(date);
  const day = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - day);
  return toIsoCalendarDate(copy);
}

function isoWeek(dateIso: string): number {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const weekOne = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  return (
    1 +
    Math.round(
      ((date.getTime() - weekOne.getTime()) / 86400000 -
        3 +
        ((weekOne.getUTCDay() + 6) % 7)) /
        7,
    )
  );
}

function weekdayLabel(dateIso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "de-DE", {
    weekday: "short",
    day: "numeric",
  }).format(new Date(`${dateIso}T00:00:00.000Z`));
}

function replaceItem(
  agenda: WeekAgendaResponse,
  itemId: number,
  patch: Partial<WeekPlanningItem>,
): WeekAgendaResponse {
  const update = (item: WeekPlanningItem): WeekPlanningItem =>
    item.id === itemId
      ? ({
          ...item,
          ...patch,
          task: item.task ? { ...item.task, ...patch } : item.task,
          project: item.project ? { ...item.project, ...patch } : item.project,
        } as WeekPlanningItem)
      : item;
  return {
    ...agenda,
    days: agenda.days.map((day) => ({
      ...day,
      items: day.items.map(update).filter((item) => item.placement !== "unplanned"),
    })),
    unplanned: agenda.unplanned.map(update).filter((item) => item.placement === "unplanned"),
  };
}

function removeItem(agenda: WeekAgendaResponse, itemId: number): WeekAgendaResponse {
  return {
    ...agenda,
    days: agenda.days.map((day) => ({
      ...day,
      items: day.items.filter((item) => item.id !== itemId),
    })),
    unplanned: agenda.unplanned.filter((item) => item.id !== itemId),
  };
}

function addItem(
  agenda: WeekAgendaResponse,
  item: WeekPlanningItem,
): WeekAgendaResponse {
  if (item.placement === "unplanned") {
    return { ...agenda, unplanned: [...agenda.unplanned, item] };
  }
  return {
    ...agenda,
    days: agenda.days.map((day) =>
      day.date === (item.placement === "scheduled" ? item.scheduledDate : item.dueDate)
        ? { ...day, items: [...day.items, item] }
        : day,
    ),
  };
}

function moveScheduled(
  agenda: WeekAgendaResponse,
  item: WeekPlanningItem,
  date: string | null,
): WeekAgendaResponse {
  const next: WeekPlanningItem = {
    ...item,
    scheduledDate: date,
    placement: date === null ? "unplanned" : "scheduled",
    task: item.task ? { ...item.task, scheduledDate: date } : item.task,
    project: item.project ? { ...item.project, scheduledDate: date } : item.project,
  } as WeekPlanningItem;
  return addItem(removeItem(agenda, item.id), next);
}

function sortAgenda(agenda: WeekAgendaResponse): WeekAgendaResponse {
  const sort = (a: WeekPlanningItem, b: WeekPlanningItem) =>
    (a.scheduledDate ?? a.dueDate ?? "9999-99-99").localeCompare(
      b.scheduledDate ?? b.dueDate ?? "9999-99-99",
    ) || a.title.localeCompare(b.title, "de") || a.id - b.id;
  return {
    ...agenda,
    days: agenda.days.map((day) => ({
      ...day,
      items: [...day.items].sort(sort),
    })),
    unplanned: [...agenda.unplanned].sort(sort),
  };
}

function WeekCard({
  item,
  members,
  onDeadlineChange,
  onDragStart,
  onOpen,
}: {
  item: WeekPlanningItem;
  members: Member[];
  onDeadlineChange: (item: WeekPlanningItem, date: string | null) => void;
  onDragStart: (item: WeekPlanningItem) => void;
  onOpen: (item: WeekPlanningItem) => void;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const owner = item.ownerMemberId
    ? members.find((member) => member.id === item.ownerMemberId) ?? null
    : null;
  const contextLabel = item.parentTitle ?? item.projectTitle;
  return (
    <article
      className={`week-card week-card-${item.role}`}
      draggable
      data-workitem-id={item.id}
      data-workitem-role={item.role}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(item.id));
        onDragStart(item);
      }}
    >
      <button
        type="button"
        className="week-card-main"
        onClick={() => onOpen(item)}
      >
        <span className="week-card-title">{item.title}</span>
        <span className="week-card-role">
          {item.role === "story" ? strings.project : strings.task}
        </span>
      </button>
      {contextLabel ? <p className="week-card-context">{contextLabel}</p> : null}
      <div className="week-card-meta">
        {owner ? (
          <span className="row">
            <MemberAvatar member={owner} size="sm" />
            <span>{owner.name}</span>
          </span>
        ) : null}
        {item.blocked ? <span className="badge">{strings.blocked}</span> : null}
        {item.dueDate ? (
          <span className="week-card-deadline">
            ⚑ {formatDate(item.dueDate, locale) ?? item.dueDate}
          </span>
        ) : null}
      </div>
      {item.tags.length > 0 || item.contexts.length > 0 ? (
        <TaskCardTags tags={item.tags} contexts={item.contexts} />
      ) : null}
      <div className="week-card-deadline-edit">
        <label htmlFor={`week-deadline-${item.id}`}>{strings.due}</label>
        <HumanDateInput
          id={`week-deadline-${item.id}`}
          value={item.dueDate}
          onChange={(date) => onDeadlineChange(item, date)}
        />
      </div>
    </article>
  );
}

function WeekDropZone({
  label,
  date,
  items,
  members,
  dragged,
  onDropItem,
  onDeadlineChange,
  onDragStart,
  onOpen,
}: {
  label: string;
  date: string | null;
  items: WeekPlanningItem[];
  members: Member[];
  dragged: WeekPlanningItem | null;
  onDropItem: (item: WeekPlanningItem, date: string | null) => void;
  onDeadlineChange: (item: WeekPlanningItem, date: string | null) => void;
  onDragStart: (item: WeekPlanningItem) => void;
  onOpen: (item: WeekPlanningItem) => void;
}) {
  const strings = useStrings();
  const drop = (event: DragEvent) => {
    event.preventDefault();
    if (dragged) onDropItem(dragged, date);
  };
  return (
    <section
      className="week-drop-zone"
      onDragOver={(event) => event.preventDefault()}
      onDrop={drop}
      aria-label={label}
    >
      <h2>{label}</h2>
      <div className="week-card-list">
        {items.length === 0 ? (
          <p className="text-muted">{strings.noItems}</p>
        ) : (
          items.map((item) => (
            <WeekCard
              key={item.id}
              item={item}
              members={members}
              onDeadlineChange={onDeadlineChange}
              onDragStart={onDragStart}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </section>
  );
}

export function WeekPage() {
  const strings = useStrings();
  const { locale } = useLocale();
  const { currentMemberId, members } = useIdentity();
  const dispatch = useWorkItemCommands();
  const navigate = useNavigate();
  const [scope] = useState<AgendaScope>("mine");
  const [start, setStart] = useState(() => weekStart(new Date()));
  const [agenda, setAgenda] = useState<WeekAgendaResponse | null>(null);
  const [dragged, setDragged] = useState<WeekPlanningItem | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const loadKey = `${start}:${scope}:${currentMemberId ?? "none"}`;
  const { data, loading, error, reload } = useAsync(
    () => api.getWeekAgenda(start, currentMemberId, scope),
    [loadKey],
  );

  useEffect(() => {
    if (data) setAgenda(data);
  }, [data]);

  const applySchedule = async (item: WeekPlanningItem, date: string | null) => {
    if (!agenda) return;
    const previous = agenda;
    setMutationError(null);
    setAgenda(sortAgenda(moveScheduled(agenda, item, date)));
    try {
      await dispatch({ type: "workItem.schedule", item, date });
    } catch (cause) {
      setAgenda(previous);
      setMutationError(cause instanceof Error ? cause.message : strings.error);
    }
  };

  const applyDeadline = async (item: WeekPlanningItem, date: string | null) => {
    if (!agenda) return;
    const previous = agenda;
    setMutationError(null);
    setAgenda(sortAgenda(replaceItem(agenda, item.id, { dueDate: date })));
    try {
      await dispatch({ type: "workItem.setDeadline", item, date });
    } catch (cause) {
      setAgenda(previous);
      setMutationError(cause instanceof Error ? cause.message : strings.error);
    }
  };

  const currentAgenda = agenda;
  const title = `${strings.weekPlanning} · ${strings.calendarWeekShort} ${isoWeek(start)}`;
  const formattedRange = useMemo(() => {
    const end = addIsoCalendarDays(start, 6);
    return `${formatDate(start, locale) ?? start}–${formatDate(end, locale) ?? end}`;
  }, [locale, start]);

  return (
    <InteractionScopeProvider>
      <WorkItemKeyboardNavMount />
      <div className="week-page">
        <PageHeader
          title={title}
          actions={
            <div className="row">
              <button
                type="button"
                className="page-header-button"
                onClick={() => setStart(addIsoCalendarDays(start, -7))}
                aria-label={strings.previousWeek}
              >
                ‹
              </button>
              <button
                type="button"
                className="page-header-button"
                onClick={() => setStart(weekStart(new Date()))}
              >
                {strings.today}
              </button>
              <button
                type="button"
                className="page-header-button"
                onClick={() => setStart(addIsoCalendarDays(start, 7))}
                aria-label={strings.nextWeek}
              >
                ›
              </button>
            </div>
          }
          hints={[{ text: strings.weekPlanningHint }]}
        />
        <p className="text-muted week-range">{formattedRange}</p>
        <Link to="/today" className="link-plain week-back-link">
          ← {strings.today}
        </Link>
        {loading ? <LoadingState /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {mutationError ? <p className="capture-error" role="alert">{mutationError}</p> : null}
        {currentAgenda ? (
          <>
            <div className="week-grid" role="list">
              {currentAgenda.days.map((day) => (
                <WeekDropZone
                  key={day.date}
                  label={weekdayLabel(day.date, locale)}
                  date={day.date}
                  items={day.items}
                  members={members}
                  dragged={dragged}
                  onDropItem={(item, date) => void applySchedule(item, date)}
                  onDeadlineChange={(item, date) => void applyDeadline(item, date)}
                  onDragStart={setDragged}
                  onOpen={(item) => {
                    if (item.role === "task") {
                      dispatch({ type: "task.open", taskId: item.id });
                    } else {
                      navigate(`/projects/${item.id}`);
                    }
                  }}
                />
              ))}
            </div>
            <WeekDropZone
              label={strings.unplanned}
              date={null}
              items={currentAgenda.unplanned}
              members={members}
              dragged={dragged}
              onDropItem={(item, date) => void applySchedule(item, date)}
              onDeadlineChange={(item, date) => void applyDeadline(item, date)}
              onDragStart={setDragged}
              onOpen={(item) => {
                if (item.role === "task") {
                  dispatch({ type: "task.open", taskId: item.id });
                } else {
                  navigate(`/projects/${item.id}`);
                }
              }}
            />
          </>
        ) : null}
        <QuickAdd />
      </div>
    </InteractionScopeProvider>
  );
}
