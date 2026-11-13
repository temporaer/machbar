import { beforeEach, describe, expect, it, vi } from "vitest";
import "../styles/index.css";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../lib/api";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { renderWithProviders } from "../test/testUtils";
import { makeTask } from "../test/fixtures";
import { TaskPlanningSheet } from "./TaskPlanningSheet";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { TaskDetailSheet } from "./TaskDetailSheet";
import type { TaskPlanningTarget } from "../lib/commands";
import { de as strings } from "../i18n/de";
import { useLocation, useNavigate } from "react-router-dom";

vi.mock("../lib/api", () => ({ api: {
  previewTaskUpdate: vi.fn(),
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
  const navigate = useNavigate();
  const location = useLocation();
  return <><span data-testid="location">{location.pathname}</span><button onClick={() => fromDetail ? dispatch({ type: "task.open", taskId: 1 }) : dispatch({ type: "task.plan", taskId: 1, target: "dependencies" })}>Open planning</button><button onClick={() => dispatch({ type: "workItem.open", workItem: { id: 3, role: "task" } })}>Generic linked task</button><button onClick={() => navigate(-1)}>Browser Back</button><button onClick={() => navigate(1)}>Browser Forward</button><button onClick={() => navigate("/projects/42")}>Navigate away</button><TaskDetailSheet /><TaskWorkflowHost /></>;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.previewTaskUpdate.mockResolvedValue({ decision: null, activatingProjects: [] });
  mocked.getMembers.mockResolvedValue([]);
  mocked.getTags.mockResolvedValue([]);
  mocked.getActivity.mockResolvedValue([] as never);
  mocked.getTaskRecurrenceHistory.mockResolvedValue({ summary: { hitCount: 0, missCount: 0, totalCount: 0, hitRate: null }, occurrences: [] });
  mocked.getTask.mockResolvedValue(makeTask({ id: 1 }) as never);
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
    openSection(section("planning-prerequisites"));
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

  it("preserves an unsaved planner draft across read-only prerequisite inspection", async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: 1, title: "Example planning", externalWait: { waitingFor: "Example reply", revisitDate: null }, dependencies: [
      { id: 1, taskId: 1, dependsOnTaskId: 2, title: "Example prerequisite", resolved: false },
    ] });
    mocked.getTask.mockImplementation(async (id) => ({ ...(id === 1 ? task : makeTask({ id, title: id === 2 ? "Example prerequisite" : "Example resolved" })), ancestors: [], childStories: [], externalRefs: [], hierarchyRevisions: [] }) as never);
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open planning" }));
    await screen.findByRole("dialog", { name: "Planung" });
    openSection(section("planning-scheduled"));
    fireEvent.change(screen.getByLabelText("Geplant für"), { target: { value: "20.10.2026" } });
    fireEvent.blur(screen.getByLabelText("Geplant für"));
    await user.selectOptions(screen.getByLabelText("Zeitfenster"), "outside");
    openSection(section("planning-waiting"));
    await user.type(screen.getByLabelText("Was ist passiert?"), "Draft outcome");
    openSection(section("planning-prerequisites"));
    await user.click(screen.getByRole("button", { name: "Example prerequisite" }));
    await screen.findByRole("heading", { name: "Example prerequisite", level: 1 });
    expect(screen.queryByRole("dialog", { name: "Planung" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Planen" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Schließen" }));
    await screen.findByRole("dialog", { name: "Planung" });
    expect(screen.getByLabelText("Geplant für")).toHaveValue("20.10.2026");
    expect(screen.getByLabelText("Zeitfenster")).toHaveValue("outside");
    expect(screen.getByLabelText("Was ist passiert?")).toHaveValue("Draft outcome");
    expect(mocked.updateTask).not.toHaveBeenCalled();
    expect(mocked.addDependency).not.toHaveBeenCalled();
    expect(mocked.removeDependency).not.toHaveBeenCalled();
  }, 15000);

  it("blocks in-app navigation for a dirty draft until stay or discard is explicit", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open planning" }));
    await screen.findByRole("dialog", { name: "Planung" });
    openSection(section("planning-scheduled"));
    fireEvent.change(screen.getByLabelText("Geplant für"), { target: { value: "20.10.2026" } });
    fireEvent.blur(screen.getByLabelText("Geplant für"));

    await user.click(screen.getByRole("button", { name: "Navigate away" }));
    const discardDialog = screen.getByRole("heading", { name: "Verwerfen" }).closest('[role="dialog"]') as HTMLElement;
    expect(discardDialog).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    await user.click(within(discardDialog).getByRole("button", { name: "Abbrechen" }));
    expect(screen.getByRole("dialog", { name: "Planung" })).toBeInTheDocument();
    expect(screen.getByLabelText("Geplant für")).toHaveValue("20.10.2026");

    await user.click(screen.getByRole("button", { name: "Navigate away" }));
    await user.click(screen.getByRole("button", { name: "Verwerfen" }));
    await screen.findByText("/projects/42");
    expect(screen.queryByRole("dialog", { name: "Planung" })).not.toBeInTheDocument();
  });

  it("uses the portaled prompt to save a dirty draft and complete blocked navigation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open planning" }));
    await screen.findByRole("dialog", { name: "Planung" });
    openSection(section("planning-scheduled"));
    fireEvent.change(screen.getByLabelText("Geplant für"), { target: { value: "20.10.2026" } });
    fireEvent.blur(screen.getByLabelText("Geplant für"));

    await user.click(screen.getByRole("button", { name: "Navigate away" }));
    const prompt = screen.getByRole("heading", { name: "Verwerfen" }).closest('[role="dialog"]') as HTMLElement;
    expect(prompt).toBeInTheDocument();
    expect(prompt).toHaveAttribute("aria-modal", "true");
    await user.click(within(prompt).getByRole("button", { name: "Speichern" }));
    await screen.findByText("/projects/42");
    expect(mocked.updateTask).toHaveBeenCalledWith(1, {
      expectedRevision: 1,
      scheduledDate: "2026-10-20",
    });
  });

  it("blocks navigation for an initially empty but invalid scheduled-date draft", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open planning" }));
    await screen.findByRole("dialog", { name: "Planung" });
    openSection(section("planning-scheduled"));
    const scheduled = screen.getByLabelText("Geplant für");
    fireEvent.change(scheduled, { target: { value: "kein Datum" } });
    fireEvent.blur(scheduled);

    await user.click(screen.getByRole("button", { name: "Navigate away" }));
    expect(screen.getByRole("heading", { name: "Verwerfen" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    expect(scheduled).toHaveValue("kein Datum");
  });

});
