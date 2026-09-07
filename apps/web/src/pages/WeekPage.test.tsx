import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WeekAgendaResponse, WeekPlanningItem } from "../lib/api";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { WeekPage } from "./WeekPage";
import { addIsoCalendarDays } from "../lib/naturalDate";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getWeekAgenda: vi.fn(),
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
  const task = makeTask({
    id,
    title,
    scheduledDate: overrides.scheduledDate ?? null,
    dueDate: overrides.dueDate ?? null,
    ownerMemberId: overrides.ownerMemberId ?? null,
    externalWait: overrides.externalWait ?? null,
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

describe("WeekPage", () => {
  beforeEach(() => {
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
      people: [],
      contexts: [],
    });
  });

  it("renders seven days plus scheduled task/story and unplanned items", async () => {
    const task = taskItem({ id: 11, title: "Müll raus", scheduledDate: "2026-09-07" });
    const story = storyItem({ id: 12, title: "Urlaub planen", scheduledDate: "2026-09-09" });
    const unplanned = taskItem({ id: 13, title: "Batterien kaufen", placement: "unplanned" });
    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({
        days: [
          day("2026-09-07", [task]),
          day("2026-09-08"),
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

    expect(await screen.findByRole("button", { name: /^Müll raus/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Urlaub planen/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Batterien kaufen/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Mo., 7.")).toBeInTheDocument();
    expect(screen.getByLabelText("So., 13.")).toBeInTheDocument();
    expect(screen.getByLabelText("Ohne Planung")).toBeInTheDocument();
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
    mockedApi.setExternalWait.mockResolvedValue(
      makeTask({
        id: 61,
        externalWait: { waitingFor: "IKEA", revisitDate: "2026-09-10" },
      }),
    );
    renderWithProviders(<WeekPage />);
    await screen.findByRole("button", { name: /^IKEA Lieferung/ });

    const transfer = dataTransfer();
    fireEvent.dragStart(card("IKEA Lieferung"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Do., 10."), { dataTransfer: transfer });

    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(61, {
        waitingFor: "IKEA",
        revisitDate: "2026-09-10",
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
    mockedApi.setExternalWait.mockResolvedValue(
      makeTask({
        id: 62,
        dueDate: "2026-09-12",
        externalWait: { waitingFor: "Spedition", revisitDate: null },
      }),
    );
    renderWithProviders(<WeekPage />);
    await screen.findByRole("button", { name: /^Spedition anrufen/ });

    const transfer = dataTransfer();
    fireEvent.dragStart(card("Spedition anrufen"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByLabelText("Ohne Planung"), { dataTransfer: transfer });

    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(62, {
        waitingFor: "Spedition",
        revisitDate: null,
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
});
