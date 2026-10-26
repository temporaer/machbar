import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { makeMember, makeProject, makeTask } from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { ProjectTaskEntrySheet } from "./ProjectTaskEntrySheet";
import { de as strings } from "../i18n/de";

vi.mock("../lib/api", () => ({ api: {
  getMembers: vi.fn(), getProject: vi.fn(), createTaskStepBatchForProject: vi.fn(), previewProjectSteps: vi.fn(),
} }));
const mocked = vi.mocked(api);
const base = makeProject({ id: 42, title: "Project", status: "backlog" });
let current = { ...base, tasks: [] as ReturnType<typeof makeTask>[] };
function open() { return renderWithProviders(<ProjectTaskEntrySheet project={current} onClose={vi.fn()} />); }
async function title(value: string) { await userEvent.type(screen.getAllByPlaceholderText("Schritt …").at(-1)!, value); }

describe("explicit project task entry", () => {
  beforeEach(() => {
    vi.clearAllMocks(); current = { ...base, tasks: [] };
    mocked.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mocked.getProject.mockImplementation(async () => current);
    mocked.previewProjectSteps.mockResolvedValue({ decision: null, activatingProjects: [] });
    mocked.createTaskStepBatchForProject.mockImplementation(async (_id, input) => {
      const tasks = input.steps.map((step, i) => makeTask({ ...step, id: 100 + i, projectId: 42 }));
      current = { ...current, revision: current.revision + 1, tasks: [...current.tasks, ...tasks] };
      return { tasks, project: current };
    });
  });
  it("labels one versus multiple tasks and creates only non-empty rows, then clears and displays them", async () => {
    open();
    expect(screen.getByRole("heading", { name: "Aufgaben hinzufügen" })).toBeVisible();
    expect(screen.getByText("Eine Aufgabe pro Zeile")).toBeVisible();
    await title("One");
    expect(screen.getByRole("button", { name: "Aufgabe hinzufügen" })).toBeEnabled();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getAllByPlaceholderText("Schritt …")[1]).toHaveFocus());
    await title("Two");
    await userEvent.click(screen.getByRole("button", { name: "2 Aufgaben hinzufügen" }));
    await waitFor(() => expect(mocked.createTaskStepBatchForProject).toHaveBeenCalledTimes(1));
    expect(mocked.createTaskStepBatchForProject.mock.calls[0]![1].steps).toEqual([{ title: "One" }, { title: "Two" }]);
    expect(await screen.findByText("One")).toBeVisible(); expect(screen.getByText("Two")).toBeVisible();
    expect(screen.getByPlaceholderText("Schritt …")).toHaveValue("");
  });
  it("restores unsaved rows after closing/navigation and preserves a failed submission", async () => {
    const view = open(); await title("Keep me");
    view.unmount(); open();
    expect(screen.getAllByPlaceholderText("Schritt …")[0]).toHaveValue("Keep me");
    mocked.createTaskStepBatchForProject.mockRejectedValueOnce(new Error("offline"));
    await userEvent.click(screen.getByRole("button", { name: "Aufgabe hinzufügen" }));
    await screen.findByRole("alert");
    expect(screen.getAllByPlaceholderText("Schritt …")[0]).toHaveValue("Keep me");
    await userEvent.click(screen.getByRole("button", { name: "Aufgabe hinzufügen" }));
    await screen.findByText("Keep me");
    expect(mocked.createTaskStepBatchForProject).toHaveBeenCalledTimes(2);
    expect(screen.getByPlaceholderText("Schritt …")).toHaveValue("");
  });
  it("collects the missing driver for the proposed dated task before any creation, without asking for an extra path", async () => {
    mocked.previewProjectSteps.mockResolvedValue({ activatingProjects: [{ id: 42, title: "Project" }], decision: {
      targetRevision: 1, expectedProjects: [{ projectId: 42, revision: 1 }],
      projects: [{ projectId: 42, title: "Project", revision: 1, ownerMemberId: null, required: ["driver"] }],
    } });
    open(); await title("Existing proposed path");
    await userEvent.click(screen.getByText(strings.stepPlanningOptional));
    fireEvent.change(screen.getByLabelText(strings.due), { target: { value: "2027-01-15" } });
    await userEvent.click(screen.getByRole("button", { name: "Aufgabe hinzufügen" }));
    const driver = await screen.findByLabelText(strings.commitmentDriverFor("Project"));
    expect(mocked.createTaskStepBatchForProject).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(strings.commitmentNextActionLabel)).not.toBeInTheDocument();
    expect(screen.getByText(strings.activationWillStart)).toBeVisible();
    await userEvent.selectOptions(driver, "1");
    await userEvent.click(screen.getByRole("button", { name: "Aufgabe hinzufügen" }));
    await waitFor(() => expect(mocked.createTaskStepBatchForProject).toHaveBeenCalledTimes(1));
    expect(mocked.createTaskStepBatchForProject.mock.calls[0]![1].activationResolution).toEqual({ expectedProjects: [{ projectId: 42, revision: 1 }], drivers: [{ projectId: 42, ownerMemberId: 1 }] });
  });
  it("refreshes stale project revisions while preserving rows and creates only the retry", async () => {
    mocked.createTaskStepBatchForProject.mockImplementationOnce(async () => {
      current = { ...current, revision: 2 };
      throw Object.assign(new Error("stale"), { code: "stale_write_conflict" });
    });
    open(); await title("Keep across stale refresh");
    await userEvent.click(screen.getByRole("button", { name: "Aufgabe hinzufügen" }));
    await screen.findByRole("alert");
    expect(screen.getAllByPlaceholderText("Schritt …")[0]).toHaveValue("Keep across stale refresh");
    await userEvent.click(screen.getByRole("button", { name: "Aufgabe hinzufügen" }));
    await screen.findByText("Keep across stale refresh");
    expect(mocked.createTaskStepBatchForProject).toHaveBeenCalledTimes(2);
    expect(mocked.createTaskStepBatchForProject.mock.calls[1]![1]).toMatchObject({ expectedRevision: 2, expectedProjectRevisions: [{ projectId: 42, revision: 2 }], steps: [{ title: "Keep across stale refresh" }] });
    expect(current.tasks).toHaveLength(1);
  });

  it("confirms a ready implicit start without inventing extra decisions", async () => {
    mocked.previewProjectSteps.mockResolvedValue({ decision: null, activatingProjects: [{ id: 42, title: "Project" }] });
    open(); await title("Dated work");
    await userEvent.click(screen.getByText(strings.stepPlanningOptional));
    fireEvent.change(screen.getByLabelText(strings.due), { target: { value: "2027-01-15" } });
    await userEvent.click(screen.getByRole("button", { name: "Aufgabe hinzufügen" }));
    await screen.findByText(strings.activationWillStart);
    expect(mocked.createTaskStepBatchForProject).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Aufgabe hinzufügen" }));
    await waitFor(() => expect(mocked.createTaskStepBatchForProject).toHaveBeenCalledTimes(1));
    expect(mocked.createTaskStepBatchForProject.mock.calls[0]![1].activationResolution).toBeUndefined();
  });
});
