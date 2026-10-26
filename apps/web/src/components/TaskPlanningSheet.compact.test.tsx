import { beforeEach, describe, expect, it, vi } from "vitest";
import "../styles/index.css";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../lib/api";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { renderWithProviders } from "../test/testUtils";
import { makeTask } from "../test/fixtures";
import { TaskPlanningSheet } from "./TaskPlanningSheet";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { TaskDetailSheet } from "./TaskDetailSheet";
import type { TaskPlanningTarget } from "../lib/commands";

vi.mock("../lib/api", () => ({ api: {
  getMembers: vi.fn(), getTags: vi.fn(), getTask: vi.fn(), updateTask: vi.fn(), getActivity: vi.fn(),
  getTaskRecurrenceHistory: vi.fn(), searchTasks: vi.fn(), addDependency: vi.fn(), removeDependency: vi.fn(),
} }));
const mocked = vi.mocked(api, true);
function section(target: string) {
  return document.querySelector<HTMLElement>(`section:has([id^="${target}"])`)!;
}
function openSection(element: HTMLElement) {
  fireEvent.click(element.querySelector(".task-planning-summary button")!);
}
function Harness({ fromDetail = false }: { fromDetail?: boolean }) {
  const dispatch = useWorkItemCommands();
  return <><button onClick={() => fromDetail ? dispatch({ type: "task.open", taskId: 1 }) : dispatch({ type: "task.plan", taskId: 1, target: "dependencies" })}>Open planning</button><button onClick={() => dispatch({ type: "workItem.open", workItem: { id: 3, role: "task" } })}>Generic linked task</button><TaskDetailSheet /><TaskWorkflowHost /></>;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.getMembers.mockResolvedValue([]);
  mocked.getTags.mockResolvedValue([]);
  mocked.getActivity.mockResolvedValue([] as never);
  mocked.getTaskRecurrenceHistory.mockResolvedValue({ summary: { hitCount: 0, missCount: 0, totalCount: 0, hitRate: null }, occurrences: [] });
});

describe("compact planning", () => {
  it.each(["de", "en"] as const)("starts compact in %s and adds a feature without writing", async (locale) => {
    const user = userEvent.setup();
    renderWithProviders(<TaskPlanningSheet task={makeTask({ scheduledDate: "2026-10-20" })} onClose={vi.fn()} />, { locale });
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(document.querySelectorAll(".task-planning-editor:not([hidden])")).toHaveLength(0);
    expect(screen.queryByText(/09:00/)).not.toBeInTheDocument();
    const revisit = section("planning-availability-date");
    await user.click(within(revisit).getByRole("button"));
    expect(within(revisit).getByRole("textbox")).toHaveFocus();
    expect(document.querySelectorAll(".task-planning-editor:not([hidden])")).toHaveLength(1);
    expect(mocked.updateTask).not.toHaveBeenCalled();
  });

  it.each(["scheduled", "availability", "deadline", "recurrence", "reminders", "waiting", "dependencies"] as TaskPlanningTarget[])("reveals and focuses only the %s direct target", (initialTarget) => {
    renderWithProviders(<TaskPlanningSheet task={makeTask()} initialTarget={initialTarget} onClose={vi.fn()} />);
    const editors = document.querySelectorAll(".task-planning-editor:not([hidden])");
    expect(editors).toHaveLength(1);
    expect(editors[0]).toContainElement(document.activeElement as HTMLElement);
    expect(mocked.updateTask).not.toHaveBeenCalled();
  });

  it("focuses a derived deadline editor without exposing an independent deadline input", () => {
    renderWithProviders(<TaskPlanningSheet task={makeTask({ scheduledDate: "2026-10-20", repeatAfterDays: 7, allowedDeviationDays: 1 })} initialTarget="deadline" onClose={vi.fn()} />);
    const editor = document.querySelector<HTMLElement>(".task-planning-editor:not([hidden])")!;
    expect(editor).toHaveFocus();
    expect(within(editor).queryByRole("textbox")).not.toBeInTheDocument();
    expect(mocked.updateTask).not.toHaveBeenCalled();
  });

  it("keeps one revisit editor synchronized with the waiting summary and reveals invalid time", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaskPlanningSheet task={makeTask({ externalWait: { waitingFor: "Example reply", revisitDate: null } })} initialTarget="waiting" onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Wiedervorlage setzen" }));
    const date = screen.getByLabelText("Datum");
    fireEvent.change(date, { target: { value: "25.10.2026" } });
    fireEvent.blur(date);
    fireEvent.change(screen.getByLabelText("Uhrzeit"), { target: { value: "02:30" } });
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    await user.type(screen.getByLabelText("Was ist passiert?"), "Example outcome");
    expect(screen.getByRole("button", { name: "Rückmeldung speichern" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Danach"), "resolve");
    expect(screen.getByRole("button", { name: "Rückmeldung speichern" })).toBeEnabled();
    await user.selectOptions(screen.getByLabelText("Danach"), "continue");
    expect(section("planning-availability-date").querySelector(".task-planning-editor")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Uhrzeit"), { target: { value: "06:00" } });
    const waiting = section("planning-waiting");
    expect(waiting).toHaveTextContent("25.10.");
    expect(document.querySelectorAll('[id^="planning-availability-date-"]')).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Wiedervorlage entfernen" }));
    expect(waiting).toHaveTextContent("Noch keine Wiedervorlage gesetzt");
    expect(mocked.updateTask).not.toHaveBeenCalled();
  });

  it("preserves recurrence and an explicit conflict decision when inspecting an ID-fallback prerequisite", async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 1, title: "Example recurring planning", revision: 1,
      scheduledDate: "2026-10-19", repeatAfterDays: 7, allowedDeviationDays: 1,
      dependencies: [{ id: 1, taskId: 1, dependsOnTaskId: 2, title: null as unknown as string, resolved: false }],
    });
    let current = task;
    mocked.getTask.mockImplementation(async (id) => ({ ...(id === 1 ? current : makeTask({ id, title: "Example prerequisite" })), ancestors: [], childStories: [], externalRefs: [], hierarchyRevisions: [] }) as never);
    mocked.updateTask.mockImplementationOnce(async () => {
      current = { ...task, revision: 2, scheduledDate: "2026-10-21" };
      throw Object.assign(new Error("stale"), { code: "stale_write_conflict" });
    });
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open planning" }));
    await screen.findByRole("dialog", { name: "Planung" });
    openSection(section("planning-scheduled"));
    fireEvent.change(screen.getByLabelText("Geplant für"), { target: { value: "20.10.2026" } });
    fireEvent.blur(screen.getByLabelText("Geplant für"));
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await user.click(await screen.findByRole("button", { name: "Meine Änderung beibehalten" }));
    await user.click(screen.getByRole("button", { name: "#2" }));
    await screen.findByRole("heading", { name: "Example prerequisite", level: 1 });
    await user.click(screen.getByRole("button", { name: "Schließen" }));
    await screen.findByRole("dialog", { name: "Planung" });
    expect(screen.getByLabelText("Geplant für")).toHaveValue("20.10.2026");
    expect(screen.getByLabelText("Wiederholen nach Tagen")).toHaveValue(7);
    expect(screen.queryByRole("button", { name: "Meine Änderung beibehalten" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
    expect(mocked.updateTask).toHaveBeenCalledTimes(1);
  }, 15000);

  it.each([false, true])("preserves planning across linked detail inspection (detail origin: %s)", async (fromDetail) => {
    const user = userEvent.setup();
    const task = makeTask({ id: 1, title: "Example planning", externalWait: { waitingFor: "Example reply", revisitDate: null }, dependencies: [
      { id: 1, taskId: 1, dependsOnTaskId: 2, title: "Example prerequisite", resolved: false },
      { id: 2, taskId: 1, dependsOnTaskId: 3, title: "Example resolved", resolved: true },
    ] });
    mocked.getTask.mockImplementation(async (id) => ({ ...(id === 1 ? task : makeTask({ id, title: id === 2 ? "Example prerequisite" : "Example resolved" })), ancestors: [], childStories: [], externalRefs: [], hierarchyRevisions: [] }) as never);
    renderWithProviders(<Harness fromDetail={fromDetail} />);
    await user.click(screen.getByRole("button", { name: "Open planning" }));
    if (fromDetail) {
      await screen.findByRole("heading", { name: "Example planning", level: 1 });
      await user.click(screen.getByRole("button", { name: "+ Planen" }));
    }
    await screen.findByRole("dialog", { name: "Planung" });
    openSection(section("planning-prerequisites"));
    openSection(section("planning-scheduled"));
    fireEvent.change(screen.getByLabelText("Geplant für"), { target: { value: "20.10.2026" } });
    fireEvent.blur(screen.getByLabelText("Geplant für"));
    await user.selectOptions(screen.getByLabelText("Zeitfenster"), "outside");
    openSection(section("planning-waiting"));
    await user.type(screen.getByLabelText("Was ist passiert?"), "Draft outcome");
    openSection(document.querySelector<HTMLElement>("section:has(.reminder-list)")!);
    await user.click(screen.getByRole("button", { name: "Benutzerdefiniert …" }));
    const reminderInput = screen.getByLabelText("Fällig");
    await user.clear(reminderInput);
    await user.type(reminderInput, "unfinished");
    const expandedCount = document.querySelectorAll(".task-planning-editor:not([hidden])").length;
    for (const title of ["Example prerequisite", "Example resolved"]) {
      if (title === "Example resolved") await user.click(screen.getByRole("button", { name: "Erledigt (1)" }));
      await user.click(screen.getByRole("button", { name: title }));
      await screen.findByRole("heading", { name: title, level: 1 });
      expect(screen.queryByRole("dialog", { name: "Planung" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Weitere Optionen" }));
      await user.click(screen.getByRole("button", { name: "Erinnern am …" }));
      const inspectedPlanning = await screen.findByRole("dialog", { name: "Planung" });
      expect(within(inspectedPlanning).getByText(title, { selector: "p" })).toBeInTheDocument();
      await user.click(within(inspectedPlanning).getByRole("button", { name: "Benutzerdefiniert …" }));
      const inspectedReminder = within(inspectedPlanning).getByLabelText("Fällig");
      expect(inspectedReminder.id).not.toBe(reminderInput.id);
      expect(document.getElementById(inspectedReminder.id)).toBe(inspectedReminder);
      expect(reminderInput).toHaveValue("unfinished");
      await user.click(within(inspectedPlanning).getByRole("button", { name: "Abbrechen" }));
      await screen.findByRole("heading", { name: title, level: 1 });
      await user.click(screen.getByRole("button", { name: "Schließen" }));
      await screen.findByRole("dialog", { name: "Planung" });
      expect(screen.getByLabelText("Geplant für")).toHaveValue("20.10.2026");
      expect(screen.getByLabelText("Zeitfenster")).toHaveValue("outside");
      expect(screen.getByLabelText("Was ist passiert?")).toHaveValue("Draft outcome");
      expect(screen.getByLabelText("Fällig")).toBe(reminderInput);
      expect(reminderInput).toHaveValue("unfinished");
      expect(document.querySelectorAll(".task-planning-editor:not([hidden])")).toHaveLength(expandedCount);
    }
    expect(mocked.updateTask).not.toHaveBeenCalled();
    expect(mocked.addDependency).not.toHaveBeenCalled();
    expect(mocked.removeDependency).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Schließen: Erinnerungen" })).toBeDisabled());
    if (fromDetail) {
      await user.click(screen.getByRole("button", { name: "Abbrechen" }));
      expect(await screen.findByRole("heading", { name: "Example planning", level: 1 })).toBeInTheDocument();
    }
  }, 15000);
  it.each([false, true])("returns through nested prerequisite planners (detail origin: %s)", async (fromDetail) => {
    const user = userEvent.setup();
    const tasks = [1, 2, 3].map((id) => makeTask({ id, title: `Nested task ${id}`, revision: 1,
      scheduledDate: "2026-10-19", repeatAfterDays: 7, allowedDeviationDays: 1,
      dependencies: id < 3 ? [{ id, taskId: id, dependsOnTaskId: id + 1, title: `Nested task ${id + 1}`, resolved: false }] : [],
    }));
    mocked.getTask.mockImplementation(async (id) => ({ ...tasks[id - 1], ancestors: [], childStories: [], externalRefs: [], hierarchyRevisions: [] }) as never);
    mocked.updateTask.mockImplementation(async (id) => {
      tasks[id - 1] = { ...tasks[id - 1]!, revision: 2, scheduledDate: "2026-10-21" };
      throw Object.assign(new Error("stale"), { code: "stale_write_conflict" });
    });
    renderWithProviders(<Harness fromDetail={fromDetail} />);
    await user.click(screen.getByRole("button", { name: "Open planning" }));
    if (fromDetail) {
      await screen.findByRole("heading", { name: "Nested task 1", level: 1 });
      await user.click(screen.getByRole("button", { name: /Geplant.*19\.10\.2026/ }));
    }
    const genericLink = screen.getByRole("button", { name: "Generic linked task", hidden: true });
    const reminders: HTMLElement[] = [];
    const expanded: number[] = [];
    for (const id of [1, 2]) {
      const planner = await screen.findByRole("dialog", { name: "Planung" });
      const reveal = (selector: string) => {
        const target = planner.querySelector<HTMLElement>(selector)!;
        if (target.querySelector(".task-planning-editor")?.hasAttribute("hidden")) openSection(target);
      };
      reveal('section:has([id^="planning-scheduled"])');
      const date = within(planner).getByLabelText("Geplant für");
      fireEvent.change(date, { target: { value: `${22 + id}.10.2026` } });
      fireEvent.blur(date);
      await user.click(within(planner).getByRole("button", { name: "Speichern" }));
      await user.click(await screen.findByRole("button", { name: "Meine Änderung beibehalten" }));
      reveal('section:has(.reminder-list)');
      await user.click(within(planner).getByRole("button", { name: "Benutzerdefiniert …" }));
      const reminder = within(planner).getByLabelText("Fällig");
      await user.clear(reminder);
      await user.type(reminder, id === 1 ? "unfinished alpha" : "unfinished beta");
      reminders.push(reminder);
      reveal('section:has([id^="planning-prerequisites"])');
      expanded.push(planner.querySelectorAll(".task-planning-editor:not([hidden])").length);
      if (id === 2 && fromDetail) fireEvent.click(genericLink);
      else await user.click(within(planner).getByRole("button", { name: `Nested task ${id + 1}` }));
      await screen.findByRole("heading", { name: `Nested task ${id + 1}`, level: 1 });
      expect(screen.queryByRole("dialog", { name: "Planung" })).not.toBeInTheDocument();
      if (id === 1) await user.click(screen.getByRole("button", { name: /Geplant.*19\.10\.2026/ }));
    }
    for (const id of [2, 1]) {
      if (id === 2) await user.keyboard("{Escape}");
      else await user.click(screen.getByRole("button", { name: "Schließen" }));
      const planner = await screen.findByRole("dialog", { name: "Planung" });
      expect(within(planner).getByText(`Nested task ${id}`, { selector: "p" })).toBeInTheDocument();
      expect(within(planner).getByLabelText("Geplant für")).toHaveValue(`${22 + id}.10.2026`);
      expect(within(planner).getByLabelText("Fällig")).toBe(reminders[id - 1]);
      expect(reminders[id - 1]).toHaveValue(id === 1 ? "unfinished alpha" : "unfinished beta");
      expect(planner.querySelectorAll(".task-planning-editor:not([hidden])")).toHaveLength(expanded[id - 1]!);
      expect(within(planner).queryByRole("button", { name: "Meine Änderung beibehalten" })).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
      if (id === 2 || fromDetail) await screen.findByRole("heading", { name: `Nested task ${id}`, level: 1 });
    }
    expect(mocked.updateTask).toHaveBeenCalledTimes(2);
  }, 20000);

});
