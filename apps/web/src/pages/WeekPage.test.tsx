import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WeekAgendaResponse, WeekPlanningItem } from "../lib/api";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { makeMember, makeProject, makeTag, makeTask } from "../test/fixtures";
import { useRefresh } from "../lib/refresh";
import { WeekPage } from "./WeekPage";
import { addIsoCalendarDays } from "../lib/naturalDate";
import {
  householdCalendarDateTimeToRevisitAt,
  householdCalendarDateToRevisitAt,
  type Task,
} from "@machbar/shared";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getWeekAgenda: vi.fn(),
    getHouseholdTimezone: vi.fn().mockResolvedValue({ timezone: "Europe/Berlin" }),
    updateTask: vi.fn(),
    updateProject: vi.fn(),
    setExternalWait: vi.fn(),
    getTags: vi.fn(),
    getProjects: vi.fn(),
    getHomeAssistantStatus: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);
const member = makeMember({ id: 1, name: "Mira" });

function day(date: string, items: WeekPlanningItem[] = []) {
  return { date, items };
}

function taskItem(overrides: Partial<WeekPlanningItem> & { id: number; title: string }): WeekPlanningItem {
  const { id, title, ...summaryOverrides } = overrides;
  const legacyRevisitDate = overrides.externalWait?.revisitDate ?? null;
  const task = makeTask({
    id,
    title,
    scheduledDate: overrides.scheduledDate ?? null,
    dueDate: overrides.dueDate ?? null,
    ownerMemberId: overrides.ownerMemberId ?? null,
    externalWait: overrides.externalWait
      ? { waitingFor: overrides.externalWait.waitingFor }
      : null,
    revisitAt:
      householdCalendarDateToRevisitAt(
        legacyRevisitDate ?? "",
        "Europe/Berlin",
      ) ?? null,
  });
  return {
    id: task.id,
    revision: task.revision,
    role: "task",
    title: task.title,
    status: task.status,
    ownerMemberId: task.ownerMemberId,
    scheduledDate: task.scheduledDate,
    dueDate: task.dueDate,
    externalWait: task.externalWait,
    placement: overrides.placement ?? (task.scheduledDate ? "scheduled" : "unplanned"),
    projectId: task.projectId,
    projectTitle: task.projectTitle,
    parentId: task.parentTaskId,
    parentTitle: null,
    tags: task.effectiveTags,
    contexts: task.effectiveContexts,
    blocked: task.blocked,
    executable: task.executable,
    stuckReason: null,
    task,
    project: null,
    ...summaryOverrides,
  } as WeekPlanningItem;
}

function storyItem(overrides: Partial<WeekPlanningItem> & { id: number; title: string }): WeekPlanningItem {
  const { id, title, ...summaryOverrides } = overrides;
  const project = makeProject({
    id,
    title,
    scheduledDate: overrides.scheduledDate ?? null,
    dueDate: overrides.dueDate ?? null,
    ownerMemberId: overrides.ownerMemberId ?? null,
  });
  return {
    id: project.id,
    revision: project.revision,
    role: "story",
    title: project.title,
    status: project.status,
    ownerMemberId: project.ownerMemberId,
    scheduledDate: project.scheduledDate,
    dueDate: project.dueDate,
    externalWait: null,
    placement: overrides.placement ?? (project.scheduledDate ? "scheduled" : "unplanned"),
    projectId: null,
    projectTitle: null,
    parentId: project.parentId,
    parentTitle: null,
    tags: project.tags,
    contexts: project.contexts,
    blocked: false,
    executable: false,
    stuckReason: null,
    task: null,
    project,
    ...summaryOverrides,
  } as WeekPlanningItem;
}

function agenda(overrides: Partial<WeekAgendaResponse> = {}): WeekAgendaResponse {
  const start = "2026-09-07";
  return {
    start,
    end: "2026-09-13",
    days: Array.from({ length: 7 }, (_, index) => day(addIsoCalendarDays(start, index))),
    unplanned: [],
    ...overrides,
  };
}

function dataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: "move",
    setData: vi.fn((key: string, value: string) => store.set(key, value)),
    getData: vi.fn((key: string) => store.get(key) ?? ""),
  };
}

function card(title: string): HTMLElement {
  const button = screen.getByRole("button", { name: new RegExp(`^${title}`) });
  const article = button.closest("article");
  if (!article) throw new Error(`No week card for ${title}`);
  return article as HTMLElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function RefreshWeek() {
  const { bump } = useRefresh();
  return <button onClick={bump}>Refresh Week</button>;
}

function responseWith(...items: WeekPlanningItem[]): WeekAgendaResponse {
  const base = agenda();
  return {
    ...base,
    days: base.days.map(day => ({ ...day, items: items.filter(item => item.attentionDate === day.date) })),
    unplanned: items.filter(item => item.placement === "unplanned"),
  };
}

function taskVersion(item: WeekPlanningItem, patch: Partial<Task>, attentionDate: string | null, placement: WeekPlanningItem["placement"]): WeekPlanningItem {
  if (item.role !== "task") throw new Error("Expected a task fixture");
  const task = { ...item.task, ...patch };
  return {
    ...item, task, revision: task.revision, title: task.title, status: task.status,
    scheduledDate: task.scheduledDate, dueDate: task.dueDate, externalWait: task.externalWait,
    ownerMemberId: task.ownerMemberId, tags: task.effectiveTags, contexts: task.effectiveContexts,
    blocked: task.blocked, executable: task.executable, attentionDate, placement,
  };
}

describe("WeekPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 7, 9));
    vi.clearAllMocks();
    window.localStorage.setItem("machbar:identity-member-id", "1");
    mockedApi.getMembers.mockResolvedValue([member]);
    mockedApi.getTags.mockResolvedValue([]);
    mockedApi.getProjects.mockResolvedValue([]);
    mockedApi.getHomeAssistantStatus.mockResolvedValue({
      connected: false,
      instanceId: null,
      protocolVersion: null,
      connectedAt: null,
      lastUpdateAt: null,
      stale: false,
      supportedProtocolVersion: 3,
      protocolOutdated: false,
      lastRequestPollAt: null,
      workerOnline: false,
      intake: null,
      intakeReady: false,
      people: [],
      contexts: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides the previous query immediately while its replacement loads or fails", async () => {
    const old = taskItem({ id: 101, title: "Old query", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const replacement = deferred<WeekAgendaResponse>();
    mockedApi.getWeekAgenda.mockImplementation((_start, _member, scope) => scope === "all" ? replacement.promise : Promise.resolve(responseWith(old)));
    renderWithProviders(<WeekPage />);
    await screen.findByText(old.title);
    await userEvent.click(screen.getByRole("button", { name: "Aufgaben aller Personen anzeigen" }));
    expect(screen.queryByText(old.title)).not.toBeInTheDocument();
    await act(async () => replacement.reject(new Error("replacement offline")));
    expect(await screen.findByRole("alert")).toHaveTextContent("replacement offline");
    expect(screen.queryByText(old.title)).not.toBeInTheDocument();
  });

  it("does not let an old-window failure restore its cards or error under the new window", async () => {
    const old = taskItem({ id: 102, title: "Old window", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const current = taskItem({ id: 103, title: "New window", scheduledDate: "2026-09-15", attentionDate: "2026-09-15" });
    const write = deferred<Task>();
    mockedApi.getWeekAgenda.mockImplementation(async start => start === "2026-09-07"
      ? responseWith(old)
      : agenda({ start, end: addIsoCalendarDays(start, 6), days: Array.from({ length: 7 }, (_, index) => day(addIsoCalendarDays(start, index), index === 1 ? [current] : [])) }));
    mockedApi.updateTask.mockReturnValue(write.promise);
    renderWithProviders(<WeekPage />);
    await screen.findByText(old.title);
    const transfer = dataTransfer();
    fireEvent.dragStart(card(old.title), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Mi., 9."), { dataTransfer: transfer });
    await userEvent.click(screen.getByRole("button", { name: "Nächste Woche" }));
    await screen.findByText(current.title);
    await act(async () => write.reject(new Error("old write offline")));
    expect(screen.getByText(current.title)).toBeInTheDocument();
    expect(screen.queryByText(old.title)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["failure", "success"] as const)("does not let first-A %s callbacks affect a returned A lifetime", async phase => {
    const old = taskItem({ id: 104, title: "First A", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const fresh = taskVersion(old, { title: "Returned A", revision: 3 }, "2026-09-08", "scheduled");
    const write = deferred<Task>();
    let returned = false;
    mockedApi.getWeekAgenda.mockImplementation(async start => start === "2026-09-07" ? responseWith(returned ? fresh : old) : agenda({ start, end: addIsoCalendarDays(start, 6) }));
    mockedApi.updateTask.mockReturnValue(write.promise);
    renderWithProviders(<WeekPage />);
    await screen.findByText(old.title);
    const transfer = dataTransfer();
    fireEvent.dragStart(card(old.title), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Mi., 9."), { dataTransfer: transfer });
    await userEvent.click(screen.getByRole("button", { name: "Nächste Woche" }));
    returned = true;
    await userEvent.click(screen.getByRole("button", { name: "Vorherige Woche" }));
    await screen.findByText(fresh.title);
    await act(async () => {
      if (phase === "failure") write.reject(new Error("first A offline"));
      else if (old.role === "task") write.resolve({ ...old.task, revision: 2, scheduledDate: "2026-09-09" });
    });
    expect(screen.getByText(fresh.title)).toBeInTheDocument();
    expect(screen.queryByText(old.title)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("removes only a failed task's intent after another task and a remote edit are accepted", async () => {
    const x = taskItem({ id: 105, title: "Pending X", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const y = taskItem({ id: 106, title: "Accepted Y", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const freshX = taskVersion(x, { title: "Remote X", revision: 2 }, "2026-09-08", "scheduled");
    const freshY = taskVersion(y, { scheduledDate: "2026-09-10", revision: 2 }, "2026-09-10", "scheduled");
    const writeX = deferred<Task>();
    const writeY = deferred<Task>();
    let server = responseWith(x, y);
    mockedApi.getWeekAgenda.mockImplementation(async () => server);
    mockedApi.updateTask.mockImplementation(id => id === x.id ? writeX.promise : writeY.promise);
    renderWithProviders(<WeekPage />);
    await screen.findByText(x.title);
    for (const [item, zone] of [[x, "Mi., 9."], [y, "Do., 10."]] as const) {
      const transfer = dataTransfer();
      fireEvent.dragStart(card(item.title), { dataTransfer: transfer });
      fireEvent.drop(screen.getByLabelText(zone), { dataTransfer: transfer });
    }
    server = responseWith(freshX, freshY);
    if (freshY.role !== "task") throw new Error("Expected task");
    await act(async () => writeY.resolve(freshY.task));
    await screen.findByText(freshX.title);
    await act(async () => writeX.reject(new Error("X stale")));
    expect(within(screen.getByLabelText("Do., 10.")).getByText(y.title)).toBeInTheDocument();
    expect(screen.getByText(freshX.title)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pending X/ })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("X stale");
    expect(screen.getAllByText(y.title)).toHaveLength(1);
  });

  it.each(["pending", "accepted"] as const)("preserves date feedback and fresh derived fields when a preacceptance read arrives while %s", async phase => {
    const item = taskItem({ id: 107, title: "Date feedback", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const tag = makeTag({ id: 501, name: "Remote tag" });
    const derived = taskVersion(item, { inheritedTags: [tag], effectiveTags: [tag] }, "2026-09-08", "scheduled");
    const accepted = taskVersion(derived, { revision: 2, scheduledDate: "2026-09-10" }, "2026-09-10", "scheduled");
    const oldRead = deferred<WeekAgendaResponse>();
    const postRead = deferred<WeekAgendaResponse>();
    const write = deferred<Task>();
    let ownerReads = 0;
    mockedApi.getWeekAgenda.mockImplementation((_start, memberId) => {
      if (memberId !== member.id) return Promise.resolve(responseWith());
      ownerReads += 1;
      return ownerReads === 1 ? Promise.resolve(responseWith(item)) : ownerReads === 2 ? oldRead.promise : postRead.promise;
    });
    mockedApi.updateTask.mockReturnValue(write.promise);
    renderWithProviders(<><RefreshWeek /><WeekPage /></>);
    await screen.findByText(item.title);
    await userEvent.click(screen.getByRole("button", { name: "Refresh Week" }));
    const transfer = dataTransfer();
    fireEvent.dragStart(card(item.title), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Mi., 9."), { dataTransfer: transfer });
    if (accepted.role !== "task") throw new Error("Expected task");
    if (phase === "accepted") await act(async () => write.resolve(accepted.task));
    await act(async () => oldRead.resolve(responseWith(derived)));
    expect(within(screen.getByLabelText(phase === "pending" ? "Mi., 9." : "Do., 10.")).getByText(item.title)).toBeInTheDocument();
    expect(screen.getByText(tag.name)).toBeInTheDocument();
    if (phase === "pending") await act(async () => write.resolve(accepted.task));
    expect(within(screen.getByLabelText("Do., 10.")).getByText(item.title)).toBeInTheDocument();
    await waitFor(() => expect(ownerReads).toBeGreaterThanOrEqual(3));
    await act(async () => postRead.resolve(responseWith(accepted)));
    expect(within(screen.getByLabelText("Do., 10.")).getByText(item.title)).toBeInTheDocument();
    expect(screen.getAllByText(item.title)).toHaveLength(1);
  });

  it.each(["absence", "role", "revision", "placement"] as const)("rejects a drag whose current authoritative target changed by %s", async change => {
    const item = taskItem({ id: 108, title: "Drag target", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    let server = responseWith(item);
    mockedApi.getWeekAgenda.mockImplementation(async () => server);
    renderWithProviders(<><RefreshWeek /><WeekPage /></>);
    await screen.findByText(item.title);
    const transfer = dataTransfer();
    fireEvent.dragStart(card(item.title), { dataTransfer: transfer });
    server = change === "absence" ? responseWith()
      : change === "role" ? responseWith(storyItem({ id: item.id, title: "Converted", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" }))
        : change === "placement" ? responseWith(taskVersion(item, { scheduledDate: null, dueDate: "2026-09-09", revision: 2 }, "2026-09-09", "due"))
          : responseWith(taskVersion(item, { revision: 2 }, "2026-09-08", "scheduled"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh Week" }));
    fireEvent.drop(screen.getByLabelText("Do., 10."), { dataTransfer: transfer });
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    expect(mockedApi.setExternalWait).not.toHaveBeenCalled();
  });

  it.each(["pending", "accepted"] as const)("keeps a preack omitted task absent while %s and only restores successful read membership", async phase => {
    const item = taskItem({ id: 120, title: "Omitted before ack", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const accepted = taskVersion(item, { revision: 2, scheduledDate: "2026-09-09" }, "2026-09-09", "scheduled");
    const oldRead = deferred<WeekAgendaResponse>();
    const nextRead = deferred<WeekAgendaResponse>();
    const write = deferred<Task>();
    let ownerReads = 0;
    mockedApi.getWeekAgenda.mockImplementation((_start, memberId) => {
      if (memberId !== member.id) return Promise.resolve(responseWith());
      return ++ownerReads === 1 ? Promise.resolve(responseWith(item)) : ownerReads === 2 ? oldRead.promise : nextRead.promise;
    });
    mockedApi.updateTask.mockReturnValue(write.promise);
    renderWithProviders(<><RefreshWeek /><WeekPage /></>);
    await screen.findByText(item.title);
    await userEvent.click(screen.getByRole("button", { name: "Refresh Week" }));
    const transfer = dataTransfer();
    fireEvent.dragStart(card(item.title), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Mi., 9."), { dataTransfer: transfer });
    if (accepted.role !== "task") throw new Error("Expected task");
    if (phase === "accepted") await act(async () => write.resolve(accepted.task));
    await act(async () => oldRead.resolve(responseWith()));
    expect(screen.queryByText(item.title)).not.toBeInTheDocument();
    fireEvent.drop(screen.getByLabelText("Do., 10."), { dataTransfer: transfer });
    expect(mockedApi.updateTask).toHaveBeenCalledOnce();
    if (phase === "pending") await act(async () => write.resolve(accepted.task));
    expect(screen.queryByText(item.title)).not.toBeInTheDocument();
    await act(async () => nextRead.resolve(responseWith(accepted)));
    expect(within(screen.getByLabelText("Mi., 9.")).getByText(item.title)).toBeInTheDocument();
    expect(screen.getAllByText(item.title)).toHaveLength(1);
  });

  it("does not resurrect an accepted task omitted by a successful qualifying read", async () => {
    const item = taskItem({ id: 121, title: "Omitted after ack", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const accepted = taskVersion(item, { revision: 2, scheduledDate: "2026-09-09" }, "2026-09-09", "scheduled");
    const read = deferred<WeekAgendaResponse>();
    let ownerReads = 0;
    mockedApi.getWeekAgenda.mockImplementation((_start, memberId) => {
      if (memberId !== member.id) return Promise.resolve(responseWith());
      return ++ownerReads === 1 ? Promise.resolve(responseWith(item)) : read.promise;
    });
    if (accepted.role !== "task") throw new Error("Expected task");
    mockedApi.updateTask.mockResolvedValue(accepted.task);
    renderWithProviders(<WeekPage />);
    await screen.findByText(item.title);
    const transfer = dataTransfer();
    fireEvent.dragStart(card(item.title), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Mi., 9."), { dataTransfer: transfer });
    await waitFor(() => expect(ownerReads).toBeGreaterThanOrEqual(2));
    await act(async () => read.resolve(responseWith()));
    await waitFor(() => expect(ownerReads).toBeGreaterThanOrEqual(3));
    expect(screen.queryByText(item.title)).not.toBeInTheDocument();
    expect(mockedApi.updateTask).toHaveBeenCalledOnce();
  });

  it.each(["pending", "accepted"] as const)("prefers a higher authoritative date while the local move is %s, including a late older success", async phase => {
    const item = taskItem({ id: 122, title: "Newer date", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const accepted = taskVersion(item, { revision: 2, scheduledDate: "2026-09-09" }, "2026-09-09", "scheduled");
    const newer = taskVersion(item, { revision: 3, scheduledDate: "2026-09-10" }, "2026-09-10", "scheduled");
    const read = deferred<WeekAgendaResponse>();
    const nextRead = deferred<WeekAgendaResponse>();
    const write = deferred<Task>();
    let ownerReads = 0;
    mockedApi.getWeekAgenda.mockImplementation((_start, memberId) => {
      if (memberId !== member.id) return Promise.resolve(responseWith());
      return ++ownerReads === 1 ? Promise.resolve(responseWith(item)) : ownerReads === 2 ? read.promise : nextRead.promise;
    });
    mockedApi.updateTask.mockReturnValue(write.promise);
    renderWithProviders(<><RefreshWeek /><WeekPage /></>);
    await screen.findByText(item.title);
    await userEvent.click(screen.getByRole("button", { name: "Refresh Week" }));
    const transfer = dataTransfer();
    fireEvent.dragStart(card(item.title), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Mi., 9."), { dataTransfer: transfer });
    if (accepted.role !== "task") throw new Error("Expected task");
    if (phase === "accepted") await act(async () => write.resolve(accepted.task));
    await act(async () => read.resolve(responseWith(newer)));
    expect(within(screen.getByLabelText("Do., 10.")).getByText(item.title)).toBeInTheDocument();
    expect(within(screen.getByLabelText("Mi., 9.")).queryByText(item.title)).not.toBeInTheDocument();
    if (phase === "pending") await act(async () => write.resolve(accepted.task));
    expect(within(screen.getByLabelText("Do., 10.")).getByText(item.title)).toBeInTheDocument();
    await act(async () => nextRead.resolve(responseWith(newer)));
    expect(screen.getAllByText(item.title)).toHaveLength(1);
  });

  it("qualifies acknowledgements independently and keeps a new pending move through another confirmation's read", async () => {
    const x = taskItem({ id: 123, title: "First ack", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const y = taskItem({ id: 124, title: "Later ack", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const acceptedX = taskVersion(x, { revision: 2, scheduledDate: "2026-09-09" }, "2026-09-09", "scheduled");
    const acceptedY = taskVersion(y, { revision: 2, scheduledDate: "2026-09-10" }, "2026-09-10", "scheduled");
    const oldRead = deferred<WeekAgendaResponse>();
    const xRead = deferred<WeekAgendaResponse>();
    const recoveryRead = deferred<WeekAgendaResponse>();
    const writeX = deferred<Task>();
    const writeY = deferred<Task>();
    const secondX = deferred<Task>();
    let ownerReads = 0;
    let xWrites = 0;
    mockedApi.getWeekAgenda.mockImplementation((_start, memberId) => {
      if (memberId !== member.id) return Promise.resolve(responseWith());
      ownerReads += 1;
      return ownerReads === 1 ? Promise.resolve(responseWith(x, y))
        : ownerReads === 2 ? oldRead.promise
          : ownerReads === 3 ? xRead.promise
            : ownerReads === 4 ? Promise.reject(new Error("later read offline")) : recoveryRead.promise;
    });
    mockedApi.updateTask.mockImplementation(id => id === y.id ? writeY.promise : ++xWrites === 1 ? writeX.promise : secondX.promise);
    renderWithProviders(<><RefreshWeek /><WeekPage /></>);
    await screen.findByText(x.title);
    await userEvent.click(screen.getByRole("button", { name: "Refresh Week" }));
    for (const [item, zone] of [[x, "Mi., 9."], [y, "Do., 10."]] as const) {
      const transfer = dataTransfer();
      fireEvent.dragStart(card(item.title), { dataTransfer: transfer });
      fireEvent.drop(screen.getByLabelText(zone), { dataTransfer: transfer });
    }
    if (acceptedX.role !== "task" || acceptedY.role !== "task") throw new Error("Expected tasks");
    await act(async () => writeX.resolve(acceptedX.task));
    await act(async () => oldRead.resolve(responseWith(x, y)));
    await waitFor(() => expect(ownerReads).toBe(3));
    await act(async () => writeY.resolve(acceptedY.task));
    const transfer = dataTransfer();
    fireEvent.dragStart(card(x.title), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Fr., 11."), { dataTransfer: transfer });
    await act(async () => xRead.resolve(responseWith(acceptedX, y)));
    expect(within(screen.getByLabelText("Fr., 11.")).getByText(x.title)).toBeInTheDocument();
    expect(within(screen.getByLabelText("Do., 10.")).getByText(y.title)).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("later read offline");
    await act(async () => secondX.reject(new Error("second X offline")));
    expect(within(screen.getByLabelText("Mi., 9.")).getByText(x.title)).toBeInTheDocument();
    expect(within(screen.getByLabelText("Do., 10.")).getByText(y.title)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await act(async () => recoveryRead.resolve(responseWith(acceptedX, acceptedY)));
    expect(screen.getAllByRole("button", { name: /^First ack/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Later ack/ })).toHaveLength(1);
  });

  it("consumes a cancelled drag instead of submitting it on a later drop", async () => {
    const item = taskItem({ id: 109, title: "Cancelled drag", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    mockedApi.getWeekAgenda.mockResolvedValue(responseWith(item));
    renderWithProviders(<WeekPage />);
    await screen.findByText(item.title);
    const transfer = dataTransfer();
    fireEvent.dragStart(card(item.title), { dataTransfer: transfer });
    fireEvent.dragEnd(card(item.title), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Mi., 9."), { dataTransfer: transfer });
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("does not install a second preview while the same task is pending", async () => {
    const item = taskItem({ id: 110, title: "Pending twice", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const write = deferred<Task>();
    mockedApi.getWeekAgenda.mockResolvedValue(responseWith(item));
    mockedApi.updateTask.mockReturnValue(write.promise);
    renderWithProviders(<WeekPage />);
    await screen.findByText(item.title);
    for (const zone of ["Mi., 9.", "Do., 10."]) {
      const transfer = dataTransfer();
      fireEvent.dragStart(card(item.title), { dataTransfer: transfer });
      fireEvent.drop(screen.getByLabelText(zone), { dataTransfer: transfer });
    }
    expect(mockedApi.updateTask).toHaveBeenCalledOnce();
    expect(within(screen.getByLabelText("Mi., 9.")).getByText(item.title)).toBeInTheDocument();
  });

  it("keeps a confirmed move editable after refresh failure and preserves it when the next move fails", async () => {
    const item = taskItem({ id: 114, title: "Confirmed move", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const accepted = taskVersion(item, { scheduledDate: "2026-09-09", revision: 2 }, "2026-09-09", "scheduled");
    let committed = false;
    mockedApi.getWeekAgenda.mockImplementation(async () => {
      if (committed) throw new Error("refresh offline");
      return responseWith(item);
    });
    mockedApi.updateTask.mockImplementationOnce(async () => {
      committed = true;
      if (accepted.role !== "task") throw new Error("Expected task");
      return accepted.task;
    }).mockRejectedValueOnce(new Error("next move offline"));
    renderWithProviders(<WeekPage />);
    await screen.findByText(item.title);
    const first = dataTransfer();
    fireEvent.dragStart(card(item.title), { dataTransfer: first });
    fireEvent.drop(screen.getByLabelText("Mi., 9."), { dataTransfer: first });
    await screen.findByText("Wochenplanung konnte nicht aktualisiert werden.");
    expect(within(screen.getByLabelText("Mi., 9.")).getByText(item.title)).toBeInTheDocument();
    const next = dataTransfer();
    fireEvent.dragStart(card(item.title), { dataTransfer: next });
    fireEvent.drop(screen.getByLabelText("Do., 10."), { dataTransfer: next });
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledTimes(2));
    expect(mockedApi.updateTask).toHaveBeenLastCalledWith(item.id, { scheduledDate: "2026-09-10", expectedRevision: 2 });
    await screen.findByText("next move offline");
    expect(within(screen.getByLabelText("Mi., 9.")).getByText(item.title)).toBeInTheDocument();
  });

  it("keeps unrelated failures attributable even after their rows disappear", async () => {
    const x = taskItem({ id: 111, title: "Failed X", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const y = taskItem({ id: 112, title: "Failed Y", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    const writeX = deferred<Task>();
    const writeY = deferred<Task>();
    let server = responseWith(x, y);
    mockedApi.getWeekAgenda.mockImplementation(async () => server);
    mockedApi.updateTask.mockImplementation(id => id === x.id ? writeX.promise : writeY.promise);
    renderWithProviders(<><RefreshWeek /><WeekPage /></>);
    await screen.findByText(x.title);
    for (const item of [x, y]) {
      const transfer = dataTransfer();
      fireEvent.dragStart(card(item.title), { dataTransfer: transfer });
      fireEvent.drop(screen.getByLabelText("Mi., 9."), { dataTransfer: transfer });
    }
    server = responseWith();
    await userEvent.click(screen.getByRole("button", { name: "Refresh Week" }));
    await act(async () => { writeX.reject(new Error("X offline")); writeY.reject(new Error("Y offline")); });
    expect(screen.queryByRole("button", { name: /^Failed X/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Failed Y/ })).not.toBeInTheDocument();
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(alerts.some(alert => alert.textContent?.includes("Failed X") && alert.textContent.includes("X offline"))).toBe(true);
    expect(alerts.some(alert => alert.textContent?.includes("Failed Y") && alert.textContent.includes("Y offline"))).toBe(true);
  });

  it("keeps read recovery separate from a current mutation failure", async () => {
    const item = taskItem({ id: 113, title: "Read recovery", scheduledDate: "2026-09-08", attentionDate: "2026-09-08" });
    mockedApi.getWeekAgenda.mockResolvedValue(responseWith(item));
    mockedApi.updateTask.mockRejectedValue(new Error("write offline"));
    renderWithProviders(<><RefreshWeek /><WeekPage /></>);
    await screen.findByText(item.title);
    const transfer = dataTransfer();
    fireEvent.dragStart(card(item.title), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Mi., 9."), { dataTransfer: transfer });
    await screen.findByRole("alert");
    mockedApi.getWeekAgenda.mockRejectedValueOnce(new Error("read offline"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh Week" }));
    const warning = await screen.findByText("Wochenplanung konnte nicht aktualisiert werden.");
    const writesBefore = mockedApi.updateTask.mock.calls.length;
    await userEvent.click(within(warning.closest('[role="alert"]') as HTMLElement).getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(screen.queryByText("Wochenplanung konnte nicht aktualisiert werden.")).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("write offline");
    expect(mockedApi.updateTask).toHaveBeenCalledTimes(writesBefore);
    expect(screen.getByRole("button", { name: /^Read recovery/ })).toBeInTheDocument();
  });

  it("renders seven days plus scheduled task/story and unplanned items", async () => {
    const task = taskItem({ id: 11, title: "Müll raus", scheduledDate: "2026-09-07" });
    const story = storyItem({
      id: 12,
      title: "Urlaub planen",
      dueDate: "2026-09-09",
      placement: "due",
    });
    const scheduledStory = storyItem({
      id: 14,
      title: "Balkon planen",
      scheduledDate: "2026-09-08",
      placement: "scheduled",
    });
    const unplanned = taskItem({ id: 13, title: "Batterien kaufen", placement: "unplanned" });
    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({
        days: [
          day("2026-09-07", [task]),
          day("2026-09-08", [scheduledStory]),
          day("2026-09-09", [story]),
          day("2026-09-10"),
          day("2026-09-11"),
          day("2026-09-12"),
          day("2026-09-13"),
        ],
        unplanned: [unplanned],
      }),
    );

    renderWithProviders(<WeekPage />);

    const taskCard = (await screen.findByRole("button", { name: /^Müll raus/ }))
      .closest("article") as HTMLElement;
    const storyCard = screen.getByRole("button", { name: /^Urlaub planen/ })
      .closest("article") as HTMLElement;
    const scheduledStoryCard = screen.getByRole("button", {
      name: /^Balkon planen/,
    }).closest("article") as HTMLElement;
    expect(screen.getByText("Ziehe Karten auf einen Tag, um sie zu planen. Das Fähnchen-Feld ändert nur die Fälligkeit.")).toBeVisible();
    expect(taskCard).toBeInTheDocument();
    expect(storyCard).toBeInTheDocument();
    expect(within(taskCard).getByText("Geplant für")).toBeInTheDocument();
    expect(
      within(scheduledStoryCard!).getByText("Geplant für"),
    ).toBeInTheDocument();
    expect(within(storyCard).getByText(/^⚑/)).toBeInTheDocument();
    expect(within(storyCard).queryByText("Wiedervorlage")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Batterien kaufen/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Mo., 7.")).toBeInTheDocument();
    expect(screen.getByLabelText("So., 13.")).toBeInTheDocument();
    expect(screen.getByLabelText("Ohne Planung")).toBeInTheDocument();
  });

  it("switches between my and household week agenda from the compact header toggle", async () => {
    mockedApi.getWeekAgenda.mockImplementation(async (_start, _memberId, scope) =>
      scope === "all"
        ? agenda({
            days: [
              day("2026-09-07", [
                taskItem({
                  id: 15,
                  title: "Haushaltsaufgabe",
                  scheduledDate: "2026-09-07",
                }),
              ]),
              day("2026-09-08"),
              day("2026-09-09"),
              day("2026-09-10"),
              day("2026-09-11"),
              day("2026-09-12"),
              day("2026-09-13"),
            ],
          })
        : agenda({
            days: [
              day("2026-09-07", [
                taskItem({
                  id: 14,
                  title: "Meine Wochenaufgabe",
                  scheduledDate: "2026-09-07",
                }),
              ]),
              day("2026-09-08"),
              day("2026-09-09"),
              day("2026-09-10"),
              day("2026-09-11"),
              day("2026-09-12"),
              day("2026-09-13"),
            ],
          }),
    );
    renderWithProviders(<WeekPage />);

    const toggle = await screen.findByRole("button", {
      name: "Aufgaben aller Personen anzeigen",
    });
    expect(toggle).toHaveClass("page-header-button", "today-scope-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(await screen.findByText("Meine Wochenaufgabe")).toBeInTheDocument();

    await userEvent.click(toggle);

    await waitFor(() =>
      expect(mockedApi.getWeekAgenda).toHaveBeenLastCalledWith(
        expect.any(String),
        1,
        "all",
      ),
    );
    expect(await screen.findByText("Haushaltsaufgabe")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(toggle);
    await waitFor(() =>
      expect(mockedApi.getWeekAgenda).toHaveBeenLastCalledWith(
        expect.any(String),
        1,
        "work",
      ),
    );

    await userEvent.click(toggle);
    await waitFor(() =>
      expect(mockedApi.getWeekAgenda).toHaveBeenLastCalledWith(
        expect.any(String),
        1,
        "mine",
      ),
    );
  });

  it("links the today-ish header icon back to Today", async () => {
    mockedApi.getWeekAgenda.mockResolvedValue(agenda());
    const { container } = renderWithProviders(<WeekPage />);

    const todayLink = await screen.findByRole("link", { name: "Heute" });
    expect(todayLink).toHaveAttribute("href", "/");
    expect(todayLink.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".page-header-button[href='/']")).toBe(
      todayLink,
    );
  });

  it("dragging a card changes scheduledDate without changing dueDate", async () => {
    const item = taskItem({
      id: 21,
      title: "Apotheke",
      scheduledDate: "2026-09-08",
      dueDate: "2026-09-15",
    });

    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({
        days: [
          day("2026-09-07"),
          day("2026-09-08", [item]),
          day("2026-09-09"),
          day("2026-09-10"),
          day("2026-09-11"),
          day("2026-09-12"),
          day("2026-09-13"),
        ],
      }),
    );
    mockedApi.updateTask.mockResolvedValue(makeTask({ id: 21, scheduledDate: "2026-09-09", dueDate: "2026-09-15" }));
    renderWithProviders(<WeekPage />);
    await screen.findByRole("button", { name: /^Apotheke/ });

    const transfer = dataTransfer();
    fireEvent.dragStart(card("Apotheke"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Mi., 9."), { dataTransfer: transfer });

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(21, {
        scheduledDate: "2026-09-09",
        expectedRevision: 1,
      }),
    );
  });

  it("renders revisit, waiting reason, and deadline chips on a waiting card", async () => {
    const item = taskItem({
      id: 51,
      title: "IKEA Lieferung",
      dueDate: "2026-09-12",
      externalWait: { waitingFor: "IKEA", revisitDate: "2026-09-11" },
      placement: "revisit",
    });
    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({
        days: [
          day("2026-09-07"),
          day("2026-09-08"),
          day("2026-09-09"),
          day("2026-09-10"),
          day("2026-09-11", [item]),
          day("2026-09-12"),
          day("2026-09-13"),
        ],
      }),
    );

    renderWithProviders(<WeekPage />);

    const ikea = (await screen.findByRole("button", { name: /^IKEA Lieferung/ })).closest("article") as HTMLElement;
    expect(within(ikea).getByText("Wiedervorlage")).toBeInTheDocument();
    expect(within(ikea).getByText("wartet auf IKEA")).toBeInTheDocument();
    expect(within(ikea).getByText(/^⚑/)).toBeInTheDocument();
  });

  it("dragging a revisit card updates revisitDate without setting scheduledDate", async () => {
    const item = taskItem({
      id: 61,
      title: "IKEA Lieferung",
      externalWait: { waitingFor: "IKEA", revisitDate: "2026-09-09" },
      placement: "revisit",
    });
    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({
        days: [
          day("2026-09-07"),
          day("2026-09-08"),
          day("2026-09-09", [item]),
          day("2026-09-10"),
          day("2026-09-11"),
          day("2026-09-12"),
          day("2026-09-13"),
        ],
      }),
    );
    mockedApi.setExternalWait.mockImplementation(async () => {
      const result = makeTask({
        id: 61, title: item.title, revision: 2, blocked: true, executable: false,
        externalWait: { waitingFor: "IKEA" },
        revisitAt: householdCalendarDateToRevisitAt("2026-09-10", "Europe/Berlin"),
      });
      mockedApi.getWeekAgenda.mockResolvedValue(responseWith(taskVersion(item, result, "2026-09-10", "revisit")));
      return result;
    });
    renderWithProviders(<WeekPage />);
    await screen.findByRole("button", { name: /^IKEA Lieferung/ });

    const transfer = dataTransfer();
    fireEvent.dragStart(card("IKEA Lieferung"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Do., 10."), { dataTransfer: transfer });

    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(61, {
        waitingFor: "IKEA",
        revisitAt: "2026-09-09T22:00:00Z",
        expectedRevision: 1,
      }),
    );
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    expect(within(screen.getByLabelText("Do., 10.")).getByRole("button", { name: /^IKEA Lieferung/ })).toBeInTheDocument();
  });

  it("dropping a revisit card onto unplanned clears revisitDate and falls back to an in-week due date", async () => {
    const item = taskItem({
      id: 62,
      title: "Spedition anrufen",
      dueDate: "2026-09-12",
      externalWait: { waitingFor: "Spedition", revisitDate: "2026-09-09" },
      placement: "revisit",
    });
    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({
        days: [
          day("2026-09-07"),
          day("2026-09-08"),
          day("2026-09-09", [item]),
          day("2026-09-10"),
          day("2026-09-11"),
          day("2026-09-12"),
          day("2026-09-13"),
        ],
      }),
    );
    mockedApi.setExternalWait.mockImplementation(async () => {
      const result = makeTask({
        id: 62, title: item.title, revision: 2, blocked: true, executable: false,
        dueDate: "2026-09-12", revisitAt: null, externalWait: { waitingFor: "Spedition" },
      });
      mockedApi.getWeekAgenda.mockResolvedValue(responseWith(taskVersion(item, result, "2026-09-12", "due")));
      return result;
    });
    renderWithProviders(<WeekPage />);
    await screen.findByRole("button", { name: /^Spedition anrufen/ });

    const transfer = dataTransfer();
    fireEvent.dragStart(card("Spedition anrufen"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Ohne Planung"), { dataTransfer: transfer });

    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(62, {
        waitingFor: "Spedition",
        revisitAt: null,
        expectedRevision: 1,
      }),
    );
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    expect(within(screen.getByLabelText("Sa., 12.")).getByRole("button", { name: /^Spedition anrufen/ })).toBeInTheDocument();
    expect(within(screen.getByLabelText("Ohne Planung")).queryByRole("button", { name: /^Spedition anrufen/ })).not.toBeInTheDocument();
  });

  it("rolls back a failed revisit drag", async () => {
    const item = taskItem({
      id: 63,
      title: "Lieferung prüfen",
      externalWait: { waitingFor: "Paketdienst", revisitDate: "2026-09-09" },
      placement: "revisit",
    });
    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({
        days: [
          day("2026-09-07"),
          day("2026-09-08"),
          day("2026-09-09", [item]),
          day("2026-09-10"),
          day("2026-09-11"),
          day("2026-09-12"),
          day("2026-09-13"),
        ],
      }),
    );
    mockedApi.setExternalWait.mockRejectedValue(new Error("stale_write_conflict"));
    renderWithProviders(<WeekPage />);
    await screen.findByRole("button", { name: /^Lieferung prüfen/ });

    const transfer = dataTransfer();
    fireEvent.dragStart(card("Lieferung prüfen"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Do., 10."), { dataTransfer: transfer });

    expect(await screen.findByRole("alert")).toHaveTextContent("stale_write_conflict");
    expect(within(screen.getByLabelText("Mi., 9.")).getByRole("button", { name: /^Lieferung prüfen/ })).toBeInTheDocument();
  });

  it("shows a localized error when moving a revisit into a daylight-saving gap", async () => {
    const item = taskItem({
      id: 64,
      title: "Lieferzeit prüfen",
      externalWait: { waitingFor: "Lieferdienst", revisitDate: "2026-03-28" },
      placement: "revisit",
    });
    item.task = {
      ...item.task!,
      revisitAt: householdCalendarDateTimeToRevisitAt(
        "2026-03-28",
        "02:30",
        "Europe/Berlin",
      ),
    };
    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({
        start: "2026-03-23",
        end: "2026-03-29",
        days: Array.from({ length: 7 }, (_, index) =>
          day(addIsoCalendarDays("2026-03-23", index), index === 5 ? [item] : []),
        ),
      }),
    );
    renderWithProviders(<WeekPage />);
    await screen.findByRole("button", { name: /^Lieferzeit prüfen/ });

    const transfer = dataTransfer();
    fireEvent.dragStart(card("Lieferzeit prüfen"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("So., 29."), { dataTransfer: transfer });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Diese lokale Uhrzeit ist in der Haushaltszeitzone ungültig oder doppeldeutig.",
    );
    expect(mockedApi.setExternalWait).not.toHaveBeenCalled();
    expect(
      within(screen.getByLabelText("Sa., 28.")).getByRole("button", {
        name: /^Lieferzeit prüfen/,
      }),
    ).toBeInTheDocument();
  });

  it("navigates scheduled, revisit, and due cards with j/k in one Week scope", async () => {
    const scheduled = taskItem({ id: 71, title: "Apotheke", scheduledDate: "2026-09-07" });
    const revisit = taskItem({
      id: 72,
      title: "IKEA Lieferung",
      externalWait: { waitingFor: "IKEA", revisitDate: "2026-09-08" },
      placement: "revisit",
    });
    const due = taskItem({ id: 73, title: "Steuer", dueDate: "2026-09-09", placement: "due" });
    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({
        days: [
          day("2026-09-07", [scheduled]),
          day("2026-09-08", [revisit]),
          day("2026-09-09", [due]),
          day("2026-09-10"),
          day("2026-09-11"),
          day("2026-09-12"),
          day("2026-09-13"),
        ],
      }),
    );
    renderWithProviders(<WeekPage />);
    await screen.findByRole("button", { name: /^Apotheke/ });

    await userEvent.keyboard("j");
    expect(screen.getByRole("button", { name: /^Apotheke/ })).toHaveFocus();
    await userEvent.keyboard("j");
    expect(screen.getByRole("button", { name: /^IKEA Lieferung/ })).toHaveFocus();
    await userEvent.keyboard("j");
    expect(screen.getByRole("button", { name: /^Steuer/ })).toHaveFocus();
  });

  it("dropping to unplanned clears scheduledDate and rolls back on failure", async () => {
    const item = taskItem({ id: 41, title: "Paket", scheduledDate: "2026-09-10" });
    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({ days: [day("2026-09-07"), day("2026-09-08"), day("2026-09-09"), day("2026-09-10", [item]), day("2026-09-11"), day("2026-09-12"), day("2026-09-13")] }),
    );
    mockedApi.updateTask.mockRejectedValue(new Error("stale_write_conflict"));
    renderWithProviders(<WeekPage />);
    await screen.findByRole("button", { name: /^Paket/ });

    const transfer = dataTransfer();
    fireEvent.dragStart(card("Paket"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Ohne Planung"), { dataTransfer: transfer });

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(41, {
        scheduledDate: null,
        expectedRevision: 1,
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("stale_write_conflict");
    expect(within(screen.getByLabelText("Do., 10.")).getByRole("button", { name: /^Paket/ })).toBeInTheDocument();
  });

  it("uses a rolling today-based title without KW/calendar-week framing", async () => {
    mockedApi.getWeekAgenda.mockResolvedValue(agenda());
    renderWithProviders(<WeekPage />);

    await screen.findByLabelText("Mo., 7.");
    expect(screen.getByRole("heading", { name: "Wochenplanung" })).toBeInTheDocument();
    expect(screen.queryByText(/KW\s*\d/)).not.toBeInTheDocument();
  });

  it("does not allow generic drag to move a due-placement card", async () => {
    const item = taskItem({
      id: 81,
      title: "Steuererklaerung",
      dueDate: "2026-09-11",
      placement: "due",
    });
    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({
        days: [
          day("2026-09-07"),
          day("2026-09-08"),
          day("2026-09-09"),
          day("2026-09-10"),
          day("2026-09-11", [item]),
          day("2026-09-12"),
          day("2026-09-13"),
        ],
      }),
    );
    renderWithProviders(<WeekPage />);
    await screen.findByRole("button", { name: /^Steuererklaerung/ });

    expect(card("Steuererklaerung")).toHaveAttribute("draggable", "false");

    const transfer = dataTransfer();
    fireEvent.dragStart(card("Steuererklaerung"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Mo., 7."), { dataTransfer: transfer });

    expect(mockedApi.updateTask).not.toHaveBeenCalled();
    expect(mockedApi.setExternalWait).not.toHaveBeenCalled();
    expect(
      within(screen.getByLabelText("Fr., 11.")).getByRole("button", {
        name: /^Steuererklaerung/,
      }),
    ).toBeInTheDocument();
  });

  it("dropping to unplanned clears scheduledDate and falls back to an in-week due date instead of unplanned", async () => {
    const item = taskItem({
      id: 82,
      title: "Formular einreichen",
      scheduledDate: "2026-09-08",
      dueDate: "2026-09-11",
    });
    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({
        days: [
          day("2026-09-07"),
          day("2026-09-08", [item]),
          day("2026-09-09"),
          day("2026-09-10"),
          day("2026-09-11"),
          day("2026-09-12"),
          day("2026-09-13"),
        ],
      }),
    );
    mockedApi.updateTask.mockImplementation(async () => {
      const result = makeTask({ id: 82, title: item.title, revision: 2, scheduledDate: null, dueDate: "2026-09-11" });
      mockedApi.getWeekAgenda.mockResolvedValue(responseWith(taskVersion(item, result, "2026-09-11", "due")));
      return result;
    });
    renderWithProviders(<WeekPage />);
    await screen.findByRole("button", { name: /^Formular einreichen/ });

    const transfer = dataTransfer();
    fireEvent.dragStart(card("Formular einreichen"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Ohne Planung"), { dataTransfer: transfer });

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(82, {
        scheduledDate: null,
        expectedRevision: 1,
      }),
    );
    expect(
      within(screen.getByLabelText("Fr., 11.")).getByRole("button", {
        name: /^Formular einreichen/,
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Ohne Planung")).queryByRole("button", {
        name: /^Formular einreichen/,
      }),
    ).not.toBeInTheDocument();
  });

  it("routes a drag drop by the item's current placement (scheduled vs revisit)", async () => {
    const scheduled = taskItem({ id: 91, title: "Rasen maehen", scheduledDate: "2026-09-08" });
    const revisit = taskItem({
      id: 92,
      title: "Anbieter nachhaken",
      externalWait: { waitingFor: "Anbieter", revisitDate: "2026-09-09" },
      placement: "revisit",
    });
    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({
        days: [
          day("2026-09-07"),
          day("2026-09-08", [scheduled]),
          day("2026-09-09", [revisit]),
          day("2026-09-10"),
          day("2026-09-11"),
          day("2026-09-12"),
          day("2026-09-13"),
        ],
      }),
    );
    mockedApi.updateTask.mockResolvedValue(
      makeTask({ id: 91, scheduledDate: "2026-09-10" }),
    );
    mockedApi.setExternalWait.mockResolvedValue(
      makeTask({ id: 92, externalWait: { waitingFor: "Anbieter", revisitDate: "2026-09-10" } }),
    );
    renderWithProviders(<WeekPage />);
    await screen.findByRole("button", { name: /^Rasen maehen/ });

    const scheduledTransfer = dataTransfer();
    fireEvent.dragStart(card("Rasen maehen"), { dataTransfer: scheduledTransfer });
    fireEvent.drop(screen.getByLabelText("Do., 10."), { dataTransfer: scheduledTransfer });
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(91, {
        scheduledDate: "2026-09-10",
        expectedRevision: 1,
      }),
    );
    expect(mockedApi.setExternalWait).not.toHaveBeenCalled();

    const revisitTransfer = dataTransfer();
    fireEvent.dragStart(card("Anbieter nachhaken"), { dataTransfer: revisitTransfer });
    fireEvent.drop(screen.getByLabelText("Do., 10."), { dataTransfer: revisitTransfer });
    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(92, {
        waitingFor: "Anbieter",
        revisitAt: "2026-09-09T22:00:00Z",
        expectedRevision: 1,
      }),
    );
    expect(mockedApi.updateTask).toHaveBeenCalledTimes(1);
  });
});
