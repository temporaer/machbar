import { Link, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  calendarDateForInstant,
  moveRevisitToCalendarDate,
  type Member,
} from "@machbar/shared";
import { api, type AgendaScope, type WeekAgendaResponse, type WeekPlanningItem } from "../lib/api";
import { addIsoCalendarDays, toIsoCalendarDate } from "../lib/naturalDate";
import { useAsync } from "../lib/useAsync";
import { useIdentity } from "../lib/identity";
import { useHouseholdTimezone } from "../lib/householdTimezone";
import { useStrings } from "../lib/strings";
import { useLocale } from "../lib/locale";
import { ErrorState, LoadingState, ReadErrorState } from "../components/AsyncStates";
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
import { localizedErrorMessage } from "../lib/errorMessage";

type WeekTaskItem = Extract<WeekPlanningItem, { role: "task" }>;
interface PlacementIntent {
  selection: symbol;
  token: number;
  taskId: number;
  field: "scheduledDate" | "revisitAt";
  value: string | null;
  revision: number;
  acknowledgedAt: number | null;
}
interface MoveError {
  selection: symbol;
  token: number;
  taskId: number;
  title: string;
  message: string;
}
interface WeekDrag {
  selection: symbol;
  id: number;
  role: WeekPlanningItem["role"];
  revision: number;
  placement: WeekPlanningItem["placement"];
  attentionDate: string | null;
}

function findAgendaItem(agenda: WeekAgendaResponse, id: number) {
  return agenda.days.flatMap(day => day.items).find(item => item.id === id) ??
    agenda.unplanned.find(item => item.id === id);
}

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
  householdTimezone = "Europe/Berlin",
): { placement: WeekPlanningItem["placement"]; attentionDate: string } | null {
  const waiting = item.role === "task" && item.externalWait !== null;
  const revisitAt = item.role === "task"
    ? item.task.revisitAt
    : item.project.revisitAt;
  const candidates = {
    scheduledDate: waiting ? null : item.scheduledDate,
    revisitAt: revisitAt ?? null,
    dueDate: item.dueDate,
  };
  const options: Array<{ placement: "scheduled" | "revisit" | "due"; raw: string }> = [];
  if (candidates.scheduledDate) options.push({ placement: "scheduled", raw: candidates.scheduledDate });
  if (candidates.revisitAt) {
    const revisitDate = calendarDateForInstant(candidates.revisitAt, householdTimezone);
    if (revisitDate) options.push({ placement: "revisit", raw: revisitDate });
  }
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
  item: WeekTaskItem,
  date: string | null,
  today: string,
  householdTimezone: string,
): WeekAgendaResponse {
  const withDate: WeekTaskItem = { ...item, scheduledDate: date, task: { ...item.task, scheduledDate: date } };
  const projected = projectAttention(withDate, today, householdTimezone);
  const next: WeekPlanningItem = projected
    ? { ...withDate, placement: projected.placement, attentionDate: projected.attentionDate }
    : { ...withDate, placement: "unplanned", attentionDate: null };
  return addItem(removeItem(agenda, item.id), next);
}

function revisitMoveValue(
  item: WeekTaskItem,
  date: string | null,
  householdTimezone: string,
): string | null {
  const currentRevisitAt = item.task.revisitAt;
  const revisitAt =
    date && currentRevisitAt
      ? moveRevisitToCalendarDate(currentRevisitAt, date, householdTimezone)
      : date
        ? null
        : null;
  if (date && currentRevisitAt && revisitAt === null) {
    throw new Error("invalid_revisit_time");
  }
  return revisitAt;
}

function moveRevisitAt(
  agenda: WeekAgendaResponse,
  item: WeekTaskItem,
  revisitAt: string | null,
  today: string,
  householdTimezone: string,
): WeekAgendaResponse {
  const withDate: WeekTaskItem = { ...item, task: { ...item.task, revisitAt } };
  const projected = projectAttention(withDate, today, householdTimezone);
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
  onDragEnd,
  onOpen,
}: {
  item: WeekPlanningItem;
  members: Member[];
  onDragStart: (item: WeekPlanningItem) => void;
  onDragEnd: () => void;
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
      draggable={item.placement !== "due"}
      data-workitem-id={item.id}
      data-workitem-role={item.role}
      data-workitem-placement={item.placement}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(item.id));
        onDragStart(item);
      }}
      onDragEnd={onDragEnd}
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
  onDropItem,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  label: string;
  date: string | null;
  items: WeekPlanningItem[];
  members: Member[];
  onDropItem: (date: string | null) => void;
  onDragStart: (item: WeekPlanningItem) => void;
  onDragEnd: () => void;
  onOpen: (item: WeekPlanningItem) => void;
}) {
  const strings = useStrings();
  const drop = (event: DragEvent) => {
    event.preventDefault();
    onDropItem(date);
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
              onDragEnd={onDragEnd}
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
  const loadKey = `${start}:${scope}:${currentMemberId ?? "none"}`;
  const selection = useMemo(() => Symbol(loadKey), [loadKey]);
  const selectionRef = useRef<symbol | null>(selection);
  selectionRef.current = selection;
  const acknowledgement = useRef(0);
  const nextToken = useRef(0);
  const operations = useRef(new Map<number, { selection: symbol; token: number; pending: boolean }>());
  const dragged = useRef<WeekDrag | null>(null);
  const [intents, setIntents] = useState<PlacementIntent[]>([]);
  const [moveErrors, setMoveErrors] = useState<MoveError[]>([]);
  const weekRead = useAsync(
    async () => {
      const startedAtAcknowledgement = acknowledgement.current;
      const agenda = await api.getWeekAgenda(start, currentMemberId, scope);
      return { selection, startedAtAcknowledgement, agenda };
    },
    [selection],
  );
  const { data, loading } = weekRead;
  const base = data?.selection === selection ? data.agenda : null;
  const taskActions = useTaskActions(base
    ? [...base.days.flatMap(day => day.items), ...base.unplanned].flatMap(item => item.role === "task" ? [item.task] : [])
    : []);
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

  useEffect(() => {
    selectionRef.current = selection;
    setIntents(current => current.filter(intent => intent.selection === selection));
    setMoveErrors(current => current.filter(error => error.selection === selection));
    for (const [id, operation] of operations.current) {
      if (operation.selection !== selection) operations.current.delete(id);
    }
    return () => {
      if (selectionRef.current === selection) selectionRef.current = null;
      if (dragged.current?.selection === selection) dragged.current = null;
    };
  }, [selection]);

  useEffect(() => {
    if (selectionRef.current !== selection || data?.selection !== selection) return;
    setIntents(current => current.filter(intent =>
      intent.selection === selection &&
      (intent.acknowledgedAt === null || data.startedAtAcknowledgement < intent.acknowledgedAt)));
  }, [data, selection]);

  let currentAgenda = base;
  for (const intent of intents) {
    if (!currentAgenda || intent.selection !== selection) continue;
    if (intent.acknowledgedAt !== null && data && data.startedAtAcknowledgement >= intent.acknowledgedAt) continue;
    const item = findAgendaItem(currentAgenda, intent.taskId);
    if (!item || item.role !== "task" || item.revision > intent.revision) continue;
    currentAgenda = intent.field === "scheduledDate"
      ? moveScheduled(currentAgenda, item, intent.value, today, householdTimezone)
      : moveRevisitAt(currentAgenda, item, intent.value, today, householdTimezone);
  }
  if (currentAgenda) currentAgenda = sortAgenda(currentAgenda);

  const applyMove = async (item: WeekTaskItem, date: string | null, field: PlacementIntent["field"]) => {
    const token = ++nextToken.current;
    const commandItem = { ...item, task: taskActions.projectTask(item.task) };
    operations.current.set(item.id, { selection, token, pending: true });
    setMoveErrors(current => current.filter(error => error.selection !== selection || error.taskId !== item.id));
    try {
      const intent: PlacementIntent = {
        selection, token, taskId: item.id, field,
        value: field === "scheduledDate" ? date : revisitMoveValue(commandItem, date, householdTimezone),
        revision: commandItem.task.revision, acknowledgedAt: null,
      };
      setIntents(current => [...current, intent]);
      const result = field === "scheduledDate"
        ? await dispatch({ type: "workItem.schedule", item: commandItem, date })
        : await dispatch({ type: "workItem.setRevisitDate", item: commandItem, date, householdTimezone });
      if (selectionRef.current !== selection || operations.current.get(item.id)?.token !== token) return;
      if (!result || !("kind" in result) || result.id !== item.id) throw new Error(strings.error);
      const acknowledgedAt = ++acknowledgement.current;
      setIntents(current => current.flatMap(existing => {
        if (existing.selection !== selection || existing.taskId !== item.id || existing.field !== field) return [existing];
        if (existing.token === token) return [{ ...intent, value: result[field], revision: result.revision, acknowledgedAt }];
        return existing.acknowledgedAt !== null && existing.revision <= result.revision ? [] : [existing];
      }));
      setMoveErrors(current => current.filter(error => error.selection !== selection || error.taskId !== item.id || error.token !== token));
      // Canonical invalidation can start before this acknowledgement is observed.
      weekRead.reload();
    } catch (cause) {
      if (selectionRef.current !== selection || operations.current.get(item.id)?.token !== token) return;
      setIntents(current => current.filter(intent => intent.selection !== selection || intent.token !== token));
      const message = cause instanceof Error && cause.message === "invalid_revisit_time"
          ? strings.invalidRevisitTime
          : localizedErrorMessage(cause, strings);
      setMoveErrors(current => [
        ...current.filter(error => error.selection !== selection || error.taskId !== item.id),
        { selection, token, taskId: item.id, title: item.title, message },
      ]);
    } finally {
      const operation = operations.current.get(item.id);
      if (operation?.selection === selection && operation.token === token) operation.pending = false;
    }
  };

  const handleDropItem = (date: string | null) => {
    const drag = dragged.current;
    dragged.current = null;
    if (!drag || drag.selection !== selection || selectionRef.current !== selection || !base) return;
    if (drag.placement === "due" || drag.role !== "task") return;
    const item = findAgendaItem(base, drag.id);
    const displayed = currentAgenda ? findAgendaItem(currentAgenda, drag.id) : undefined;
    const operation = operations.current.get(drag.id);
    const pending = taskActions.isPending(drag.id) || (operation?.selection === selection && operation.pending);
    const changed = !item || !displayed || item.role !== drag.role || item.revision !== drag.revision ||
      displayed.placement !== drag.placement || displayed.attentionDate !== drag.attentionDate;
    if (pending || changed) {
      const token = operation?.selection === selection ? operation.token : ++nextToken.current;
      setMoveErrors(current => [
        ...current.filter(error => error.selection !== selection || error.taskId !== drag.id),
        { selection, token, taskId: drag.id, title: item?.title ?? strings.task, message: pending ? strings.weekMovePending : strings.weekDragChanged },
      ]);
      return;
    }
    if (item.role === "task") void applyMove(item, date, drag.placement === "revisit" ? "revisitAt" : "scheduledDate");
  };
  const startDrag = (item: WeekPlanningItem) => {
    dragged.current = { selection, id: item.id, role: item.role, revision: item.revision, placement: item.placement, attentionDate: item.attentionDate };
  };
  const endDrag = () => {
    if (dragged.current?.selection === selection) dragged.current = null;
  };

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
        <ReadErrorState resource={strings.weekPlanning} {...weekRead} />
        {moveErrors.filter(error => error.selection === selection).map(error =>
          <ErrorState key={`${error.taskId}:${error.token}`} title={error.title} message={error.message} />)}
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
                  onDropItem={handleDropItem}
                  onDragStart={startDrag}
                  onDragEnd={endDrag}
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
              onDropItem={handleDropItem}
              onDragStart={startDrag}
              onDragEnd={endDrag}
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
