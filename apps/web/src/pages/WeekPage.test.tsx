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

  it("editing the deadline changes dueDate without changing scheduledDate", async () => {
    const item = taskItem({
      id: 31,
      title: "Steuer",
      scheduledDate: "2026-09-09",
      dueDate: null,
    });
    mockedApi.getWeekAgenda.mockResolvedValue(
      agenda({ days: [day("2026-09-07"), day("2026-09-08"), day("2026-09-09", [item]), day("2026-09-10"), day("2026-09-11"), day("2026-09-12"), day("2026-09-13")] }),
    );
    mockedApi.updateTask.mockResolvedValue(makeTask({ id: 31, scheduledDate: "2026-09-09", dueDate: "2026-09-15" }));
    renderWithProviders(<WeekPage />);
    const steuer = await screen.findByRole("button", { name: /^Steuer/ });

    await userEvent.type(within(steuer.closest("article") as HTMLElement).getByRole("textbox"), "15.09.2026{enter}");

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(31, {
        dueDate: "2026-09-15",
        expectedRevision: 1,
      }),
    );
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
