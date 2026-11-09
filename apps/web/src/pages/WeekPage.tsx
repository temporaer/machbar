import { Link, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  calendarDateForInstant,
  moveRevisitToCalendarDate,
  type Member,
} from "@machbar/shared";
import { api, type AgendaScope, type WeekPlanningItem } from "../lib/api";
import { addIsoCalendarDays, toIsoCalendarDate } from "../lib/naturalDate";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useHouseholdTimezone } from "../lib/householdTimezone";
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
import { readTodayScope, writeTodayScope, nextAgendaScope } from "../lib/todayScope";
import { useTaskActions } from "../lib/useTaskActions";
import { useProjectActions } from "../lib/useProjectActions";

function weekWindowStart(date: Date): string {
  return toIsoCalendarDate(date);
}

function weekdayLabel(dateIso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "de-DE", {
    weekday: "short",
    day: "numeric",
  }).format(new Date(`${dateIso}T00:00:00.000Z`));
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
  const taskActions = useTaskActions();
  const projectActions = useProjectActions();
  const busy = (item.role === "task" ? taskActions : projectActions).isPending(item.id);
  const owner = item.ownerMemberId
    ? members.find((member) => member.id === item.ownerMemberId) ?? null
    : null;
  const contextLabel = item.parentTitle ?? item.projectTitle;
  const chipList = [] as Array<{ key: string; label: string; className: string }>;
  if (item.placement === "scheduled") {
    chipList.push({
      key: "scheduled",
      label: strings.scheduled,
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
      draggable={!busy && item.placement !== "due"}
      aria-busy={busy}
      data-workitem-id={item.id}
      data-workitem-role={item.role}
      data-workitem-placement={item.placement}
      onDragStart={(event) => {
        if (busy) { event.preventDefault(); return; }
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
  const {
    timezone: householdTimezone,
    loaded: timezoneLoaded,
  } = useHouseholdTimezone();
  const [scope, setScope] = useState<AgendaScope>(readTodayScope);
  const [start, setStart] = useState(() => weekWindowStart(new Date()));
  const navigatedRef = useRef(false);
  const now = useMemo(() => new Date().toISOString(), []);
  const today = useMemo(
    () => calendarDateForInstant(now, householdTimezone) ?? toIsoCalendarDate(new Date()),
    [householdTimezone, now],
  );
  const [dragged, setDragged] = useState<WeekPlanningItem | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const loadKey = `${start}:${scope}:${currentMemberId ?? "none"}`;
  const { data, loading, error, reload } = useAsync(
    () => api.getWeekAgenda(start, currentMemberId, scope),
    [loadKey],
  );
  const agenda = data;
  const selectScope = (nextScope: AgendaScope) => {
    setScope(nextScope);
    writeTodayScope(nextScope);
  };
  const navigateWeek = (days: number) => {
    navigatedRef.current = true;
    setStart(addIsoCalendarDays(start, days));
  };

  useEffect(() => {
    if (timezoneLoaded && !navigatedRef.current) setStart(today);
  }, [timezoneLoaded, today]);

  const applySchedule = async (
    item: Extract<WeekPlanningItem, { role: "task" }>,
    date: string | null,
  ) => {
    if (!agenda) return;
    setMutationError(null);
    try {
      await dispatch({ type: "workItem.schedule", item, date });
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : strings.error);
    }
  };

  const applyRevisitDate = async (
    item: WeekPlanningItem,
    date: string | null,
  ) => {
    if (!agenda) return;
    setMutationError(null);
    try {
      const currentRevisitAt = item.role === "task" ? item.task.revisitAt : item.project.revisitAt;
      if (date && currentRevisitAt && moveRevisitToCalendarDate(currentRevisitAt, date, householdTimezone) === null) {
        throw new Error("invalid_revisit_time");
      }
      await dispatch({
        type: "workItem.setRevisitDate",
        item,
        date,
        householdTimezone,
      });
    } catch (cause) {
      setMutationError(
        cause instanceof Error && cause.message === "invalid_revisit_time"
          ? strings.invalidRevisitTime
          : cause instanceof Error
            ? cause.message
            : strings.error,
      );
    }
  };

  // Drag routes to whichever date field is responsible for the item's
  // current placement: a deadline (`due`) is never moved by generic drag.
  const handleDropItem = (item: WeekPlanningItem, date: string | null) => {
    if (item.placement === "due" || item.role !== "task") return;
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
                onClick={() => navigateWeek(-7)}
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
                onClick={() => navigateWeek(7)}
                aria-label={strings.nextWeek}
              >
                ›
              </button>
              <button
                type="button"
                className="page-header-button today-scope-toggle"
                aria-label={
                  scope === "mine"
                    ? strings.todayHouseholdScope
                    : scope === "all"
                      ? strings.todayWorkScope
                      : strings.todayMineScope
                }
                aria-pressed={scope !== "mine"}
                title={
                  scope === "mine"
                    ? strings.todayHouseholdScope
                    : scope === "all"
                      ? strings.todayWorkScope
                      : strings.todayMineScope
                }
                onClick={() => selectScope(nextAgendaScope(scope))}
              >
                <IconActionGlyph
                  kind={
                    scope === "mine" ? "owner" : scope === "all" ? "household" : "work"
                  }
                />
              </button>
            </div>
          }
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
            <p className="text-muted" id="week-gesture-hint">{strings.weekPlanningHint}</p>
            <div className="week-grid" role="list" aria-describedby="week-gesture-hint">
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
        <QuickAdd {...(scope === "work" ? { defaultScope: "work" as const } : {})} />
      </div>
    </InteractionScopeProvider>
  );
}
