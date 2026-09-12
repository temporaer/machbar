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
import { TaskCardTags } from "../components/TaskCardTags";
import { MemberAvatar } from "../components/MemberAvatar";
import { formatDate } from "../lib/format";
import { QuickAdd } from "../components/QuickAdd";
import { IconActionGlyph } from "../components/IconActionButton";
import { readTodayScope, writeTodayScope } from "../lib/todayScope";

function weekWindowStart(date: Date): string {
  return toIsoCalendarDate(date);
}

function weekdayLabel(dateIso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "de-DE", {
    weekday: "short",
    day: "numeric",
  }).format(new Date(`${dateIso}T00:00:00.000Z`));
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
  if (item.placement === "unplanned" || item.attentionDate === null) {
    return { ...agenda, unplanned: [...agenda.unplanned, item] };
  }
  return {
    ...agenda,
    days: agenda.days.map((day) =>
      day.date === item.attentionDate
        ? { ...day, items: [...day.items, item] }
        : day,
    ),
  };
}

/**
 * Projects an item's current placement + attention date from its (possibly
 * just-mutated) source dates, mirroring the shared backend algorithm in
 * `projectWeekAttention` so optimistic frontend updates match the server.
 * `today` is the window's start when it equals the real rolling anchor;
 * callers only invoke this for items already visible in the current week.
 */
function projectAttention(
  item: WeekPlanningItem,
  today: string,
): { placement: WeekPlanningItem["placement"]; attentionDate: string } | null {
  const waiting = item.role === "task" && item.externalWait !== null;
  const candidates = {
    scheduledDate: waiting ? null : item.scheduledDate,
    revisitDate: waiting ? item.externalWait?.revisitDate ?? null : null,
    dueDate: item.dueDate,
  };
  const options: Array<{ placement: "scheduled" | "revisit" | "due"; raw: string }> = [];
  if (candidates.scheduledDate) options.push({ placement: "scheduled", raw: candidates.scheduledDate });
  if (candidates.revisitDate) options.push({ placement: "revisit", raw: candidates.revisitDate });
  if (candidates.dueDate) options.push({ placement: "due", raw: candidates.dueDate });
  if (options.length === 0) return null;
  const priority = { scheduled: 0, revisit: 1, due: 2 } as const;
  const projected = options
    .map((option) => ({
      placement: option.placement,
      attentionDate: option.raw < today ? today : option.raw,
    }))
    .sort(
      (a, b) =>
        a.attentionDate.localeCompare(b.attentionDate) ||
        priority[a.placement] - priority[b.placement],
    );
  return projected[0]!;
}

function moveScheduled(
  agenda: WeekAgendaResponse,
  item: WeekPlanningItem,
  date: string | null,
  today: string,
): WeekAgendaResponse {
  const task = item.task ? { ...item.task, scheduledDate: date } : item.task;
  const project = item.project ? { ...item.project, scheduledDate: date } : item.project;
  const withDate: WeekPlanningItem = { ...item, scheduledDate: date, task, project } as WeekPlanningItem;
  const projected = projectAttention(withDate, today);
  const next: WeekPlanningItem = projected
    ? { ...withDate, placement: projected.placement, attentionDate: projected.attentionDate }
    : { ...withDate, placement: "unplanned", attentionDate: null };
  return addItem(removeItem(agenda, item.id), next);
}

function moveRevisit(
  agenda: WeekAgendaResponse,
  item: WeekPlanningItem,
  date: string | null,
  today: string,
): WeekAgendaResponse {
  if (item.role !== "task" || !item.externalWait) return agenda;
  const externalWait = { ...item.externalWait, revisitDate: date };
  const task = { ...item.task, externalWait };
  const withDate: WeekPlanningItem = { ...item, externalWait, task } as WeekPlanningItem;
  const projected = projectAttention(withDate, today);
  const next: WeekPlanningItem = projected
    ? { ...withDate, placement: projected.placement, attentionDate: projected.attentionDate }
    : { ...withDate, placement: "unplanned", attentionDate: null };
  return addItem(removeItem(agenda, item.id), next);
}

function sortAgenda(agenda: WeekAgendaResponse): WeekAgendaResponse {
  const placementOrder: Record<WeekPlanningItem["placement"], number> = {
    scheduled: 0,
    revisit: 1,
    due: 2,
    unplanned: 3,
  };
  const sort = (a: WeekPlanningItem, b: WeekPlanningItem) =>
    (a.attentionDate ?? "9999-99-99").localeCompare(b.attentionDate ?? "9999-99-99") ||
    placementOrder[a.placement] - placementOrder[b.placement] ||
    (a.role !== b.role ? (a.role === "story" ? -1 : 1) : 0) ||
    a.title.localeCompare(b.title, "de") ||
    a.id - b.id;
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
  onDragStart,
  onOpen,
}: {
  item: WeekPlanningItem;
  members: Member[];
  onDragStart: (item: WeekPlanningItem) => void;
  onOpen: (item: WeekPlanningItem) => void;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const owner = item.ownerMemberId
    ? members.find((member) => member.id === item.ownerMemberId) ?? null
    : null;
  const contextLabel = item.parentTitle ?? item.projectTitle;
  const chipList = [] as Array<{ key: string; label: string; className: string }>;
  if (item.placement === "scheduled") {
    chipList.push({
      key: "scheduled",
      label:
        item.role === "story" ? strings.projectRevisitDate : strings.scheduled,
      className: "week-card-chip week-card-chip-scheduled",
    });
  }
  if (item.placement === "revisit") {
    chipList.push({
      key: "revisit",
      label: strings.revisit,
      className: "week-card-chip week-card-chip-revisit",
    });
  }
  if (item.dueDate) {
    chipList.push({
      key: "due",
      label: `⚑ ${formatDate(item.dueDate, locale) ?? item.dueDate}`,
      className: "week-card-chip week-card-chip-due",
    });
  }
  if (item.externalWait?.waitingFor?.trim()) {
    const waitingFor = item.externalWait.waitingFor.trim();
    chipList.push({
      key: "waiting",
      label: `${strings.waitingFor.toLowerCase()} ${waitingFor}`,
      className: "week-card-chip week-card-chip-waiting",
    });
  }
  if (item.stuckReason === "completion_review") {
    chipList.push({
      key: "review",
      label: strings.readyToComplete,
      className: "week-card-chip week-card-chip-review",
    });
  } else if (item.stuckReason) {
    chipList.push({
      key: "stuck",
      label: strings.stuck,
      className: "week-card-chip week-card-chip-stuck",
    });
  } else if (item.blocked) {
    chipList.push({
      key: "blocked",
      label: strings.blocked,
      className: "week-card-chip week-card-chip-blocked",
    });
  }
  return (
    <article
      className={`week-card week-card-${item.role}`}
      draggable={item.placement !== "due"}
      data-workitem-id={item.id}
      data-workitem-role={item.role}
      data-workitem-placement={item.placement}
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
        {chipList.length > 0 ? (
          <div className="week-card-chips" aria-label={strings.weekPlanning}>
            {chipList.map((chip) => (
              <span key={chip.key} className={chip.className}>
                {chip.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {item.tags.length > 0 || item.contexts.length > 0 ? (
        <TaskCardTags tags={item.tags} contexts={item.contexts} />
      ) : null}
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
  onDragStart,
  onOpen,
}: {
  label: string;
  date: string | null;
  items: WeekPlanningItem[];
  members: Member[];
  dragged: WeekPlanningItem | null;
  onDropItem: (item: WeekPlanningItem, date: string | null) => void;
  onDragStart: (item: WeekPlanningItem) => void;
  onOpen: (item: WeekPlanningItem) => void;
}) {
  const strings = useStrings();
  const drop = (event: DragEvent) => {
    event.preventDefault();
    // A deadline is a hard constraint: generic drag never moves it.
    if (dragged && dragged.placement !== "due") onDropItem(dragged, date);
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
  const [scope, setScope] = useState<AgendaScope>(readTodayScope);
  const [start, setStart] = useState(() => weekWindowStart(new Date()));
  // Real wall-clock today, independent of `start` paging, used to clamp
  // overdue attention dates forward when recomputing placement optimistically.
  const today = useMemo(() => toIsoCalendarDate(new Date()), []);
  const [agenda, setAgenda] = useState<WeekAgendaResponse | null>(null);
  const [dragged, setDragged] = useState<WeekPlanningItem | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const loadKey = `${start}:${scope}:${currentMemberId ?? "none"}`;
  const { data, loading, error, reload } = useAsync(
    () => api.getWeekAgenda(start, currentMemberId, scope),
    [loadKey],
  );
  const selectScope = (nextScope: AgendaScope) => {
    setScope(nextScope);
    writeTodayScope(nextScope);
  };

  useEffect(() => {
    if (data) setAgenda(data);
  }, [data]);

  const applySchedule = async (item: WeekPlanningItem, date: string | null) => {
    if (!agenda) return;
    const previous = agenda;
    setMutationError(null);
    setAgenda(sortAgenda(moveScheduled(agenda, item, date, today)));
    try {
      await dispatch({ type: "workItem.schedule", item, date });
    } catch (cause) {
      setAgenda(previous);
      setMutationError(cause instanceof Error ? cause.message : strings.error);
    }
  };

  const applyRevisitDate = async (
    item: WeekPlanningItem,
    date: string | null,
  ) => {
    if (!agenda || item.role !== "task" || !item.externalWait) return;
    const previous = agenda;
    setMutationError(null);
    setAgenda(sortAgenda(moveRevisit(agenda, item, date, today)));
    try {
      await dispatch({ type: "workItem.setRevisitDate", item, date });
    } catch (cause) {
      setAgenda(previous);
      setMutationError(cause instanceof Error ? cause.message : strings.error);
    }
  };

  // Drag routes to whichever date field is responsible for the item's
  // current placement: a deadline (`due`) is never moved by generic drag.
  const handleDropItem = (item: WeekPlanningItem, date: string | null) => {
    if (item.placement === "due") return;
    if (item.placement === "revisit") {
      void applyRevisitDate(item, date);
      return;
    }
    void applySchedule(item, date);
  };

  const currentAgenda = agenda;
  const title = strings.weekPlanning;
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
              <Link
                to="/"
                className="page-header-button"
                aria-label={strings.today}
                title={strings.today}
              >
                <IconActionGlyph kind="today" />
              </Link>
              <button
                type="button"
                className="page-header-button"
                onClick={() => setStart(addIsoCalendarDays(start, 7))}
                aria-label={strings.nextWeek}
              >
                ›
              </button>
              <button
                type="button"
                className="page-header-button today-scope-toggle"
                aria-label={strings.todayHouseholdScope}
                aria-pressed={scope === "all"}
                title={strings.todayHouseholdScope}
                onClick={() => selectScope(scope === "mine" ? "all" : "mine")}
              >
                <IconActionGlyph kind="household" />
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
                  onDropItem={handleDropItem}
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
              onDropItem={handleDropItem}
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
