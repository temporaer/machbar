import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { TaskDetailProvider, useTaskDetail } from "../lib/taskDetailContext";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { TaskWorkflowHost } from "../components/TaskWorkflowHost";
import { TaskDetailSheet } from "../components/TaskDetailSheet";
import { renderWithProviders } from "../test/testUtils";
import { makeTask } from "../test/fixtures";
import { TaskDeepLinkPage } from "./TaskDeepLinkPage";

function CloseHarness() {
  const { openTaskId, close } = useTaskDetail();
  return (
    <button type="button" onClick={close}>
      close {openTaskId ?? "none"}
    </button>
  );
}

function DeepLinkStateHarness() {
  const { openTaskId, close } = useTaskDetail();
  const navigate = useNavigate();
  return (
    <>
      <p>open task {openTaskId ?? "none"}</p>
      <button type="button" onClick={() => navigate("/tasks/43")}>Open next task</button>
      <button type="button" onClick={close}>Close detail</button>
    </>
  );
}

function PlannerDeepLinkHarness() {
  const workflow = useTaskWorkflow();
  const detail = useTaskDetail();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => workflow.open("plan", 41)}>
        Open planner
      </button>
      <button type="button" onClick={() => navigate("/tasks/42")}>
        Open deep link
      </button>
      <button type="button" onClick={() => navigate(-1)}>Browser Back</button>
      <button type="button" onClick={() => navigate(1)}>Browser Forward</button>
      <p>planner {workflow.current?.taskId ?? "none"}</p>
      <p>open task {detail.openTaskId ?? "none"}</p>
      <p>path {location.pathname}</p>
    </>
  );
}

describe("TaskDeepLinkPage", () => {
  beforeEach(() => {
    vi.spyOn(api, "getTask").mockImplementation(async (id) => makeTask({ id }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the existing task detail state and returns to Today when it closes", async () => {
    render(
      <MemoryRouter initialEntries={["/tasks/42"]}>
        <TaskDetailProvider>
          <CloseHarness />
          <Routes>
            <Route path="/tasks/:id" element={<TaskDeepLinkPage />} />
            <Route path="/today" element={<p>Today route</p>} />
          </Routes>
        </TaskDetailProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "close 42" })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: "close 42" }));
    expect(await screen.findByText("Today route")).toBeInTheDocument();
  });

  it("lets route-owned deep links survive task navigation while the host observes history", async () => {
    renderWithProviders(
      <>
        <Routes>
          <Route path="/tasks/:id" element={<TaskDeepLinkPage />} />
          <Route path="/today" element={<p>Today route</p>} />
        </Routes>
        <DeepLinkStateHarness />
        <TaskWorkflowHost />
      </>,
      { initialEntries: ["/tasks/42"] },
    );

    expect(await screen.findByText("open task 42")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open next task" }));
    expect(await screen.findByText("open task 43")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close detail" }));
    expect(await screen.findByText("Today route")).toBeInTheDocument();
  });

  it("preserves the generated detail opening identity through a planning return", async () => {
    function HandoffHarness() {
      const detail = useTaskDetail();
      const workflow = useTaskWorkflow();
      return (
        <>
          <button
            type="button"
            onClick={() => workflow.open("plan", 42, undefined, detail.getHandoff())}
          >
            Open planner
          </button>
          <button type="button" onClick={workflow.close}>Close planner</button>
          <button type="button" onClick={detail.close}>Close detail</button>
          <p>detail {detail.openTaskId ?? "none"}</p>
          <p>detail opening {workflow.detailOpeningId ?? "none"}</p>
        </>
      );
    }

    renderWithProviders(
      <>
        <Routes>
          <Route path="/tasks/:id" element={<TaskDeepLinkPage />} />
        </Routes>
        <HandoffHarness />
      </>,
      { initialEntries: ["/tasks/42"] },
    );

    await screen.findByText("detail 42");
    await userEvent.click(screen.getByRole("button", { name: "Open planner" }));
    await userEvent.click(screen.getByRole("button", { name: "Close planner" }));
    expect(screen.getByText("detail opening 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close detail" }));
    expect(screen.getByText("detail none")).toBeInTheDocument();
  });

  it("retires a clean planner before a route-owned task deep link opens", async () => {
    renderWithProviders(
      <>
        <Routes>
          <Route path="/tasks/:id" element={<TaskDeepLinkPage />} />
        </Routes>
        <PlannerDeepLinkHarness />
        <TaskDetailSheet />
        <TaskWorkflowHost />
      </>,
      { initialEntries: ["/tasks/41"] },
    );

    await screen.findByText("open task 41");
    await userEvent.click(screen.getByRole("button", { name: "Open planner" }));
    expect(await screen.findByRole("dialog", { name: "Planung" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open deep link" }));

    expect(await screen.findByText("path /tasks/42")).toBeInTheDocument();
    expect(screen.getByText("planner none")).toBeInTheDocument();
    expect(await screen.findByText("open task 42")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Planung" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(await screen.findByText("path /tasks/41")).toBeInTheDocument();
    expect(await screen.findByText("open task 41")).toBeInTheDocument();
    expect(screen.getByText("planner none")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Planung" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Browser Forward" }));
    expect(await screen.findByText("path /tasks/42")).toBeInTheDocument();
    expect(await screen.findByText("open task 42")).toBeInTheDocument();
    expect(screen.getByText("planner none")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Planung" })).not.toBeInTheDocument();
  });

  it("blocks a dirty planner before a task deep link and completes after discard", async () => {
    renderWithProviders(
      <>
        <Routes>
          <Route path="/tasks/:id" element={<TaskDeepLinkPage />} />
        </Routes>
        <PlannerDeepLinkHarness />
        <TaskDetailSheet />
        <TaskWorkflowHost />
      </>,
      { initialEntries: ["/tasks/41"] },
    );

    await screen.findByText("open task 41");
    await userEvent.click(screen.getByRole("button", { name: "Open planner" }));
    const planning = await screen.findByRole("dialog", { name: "Planung" });
    const scheduled = document.querySelector<HTMLElement>('section:has([id^="planning-scheduled"])')!;
    await userEvent.click(scheduled.querySelector("button")!);
    await userEvent.clear(screen.getByLabelText("Geplant für"));
    await userEvent.type(screen.getByLabelText("Geplant für"), "21.10.2026");
    await userEvent.tab();

    await userEvent.click(screen.getByRole("button", { name: "Open deep link" }));
    const prompt = await screen.findByRole("dialog", { name: "Verwerfen" });
    await userEvent.click(within(prompt).getByRole("button", { name: "Abbrechen" }));
    expect(screen.getByText("path /tasks/41")).toBeInTheDocument();
    expect(planning).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open deep link" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Verwerfen" })).getByRole("button", { name: "Verwerfen" }));
    expect(await screen.findByText("path /tasks/42")).toBeInTheDocument();
    expect(screen.getByText("open task 42")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Planung" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(await screen.findByText("path /tasks/41")).toBeInTheDocument();
    expect(await screen.findByText("open task 41")).toBeInTheDocument();
    expect(screen.getByText("planner none")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Planung" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Browser Forward" }));
    expect(await screen.findByText("path /tasks/42")).toBeInTheDocument();
    expect(await screen.findByText("open task 42")).toBeInTheDocument();
    expect(screen.getByText("planner none")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Planung" })).not.toBeInTheDocument();
  });

  it("saves a dirty planner and completes task deep-link navigation without restoring it", async () => {
    vi.spyOn(api, "updateTask").mockResolvedValue(
      makeTask({ id: 41, scheduledDate: "2026-10-21" }) as never,
    );
    renderWithProviders(
      <>
        <Routes>
          <Route path="/tasks/:id" element={<TaskDeepLinkPage />} />
        </Routes>
        <PlannerDeepLinkHarness />
        <TaskDetailSheet />
        <TaskWorkflowHost />
      </>,
      { initialEntries: ["/tasks/41"] },
    );

    await screen.findByText("open task 41");
    await userEvent.click(screen.getByRole("button", { name: "Open planner" }));
    await screen.findByRole("dialog", { name: "Planung" });
    const scheduled = document.querySelector<HTMLElement>('section:has([id^="planning-scheduled"])')!;
    await userEvent.click(scheduled.querySelector("button")!);
    await userEvent.clear(screen.getByLabelText("Geplant für"));
    await userEvent.type(screen.getByLabelText("Geplant für"), "21.10.2026");
    await userEvent.tab();
    await userEvent.click(screen.getByRole("button", { name: "Open deep link" }));

    const prompt = await screen.findByRole("dialog", { name: "Verwerfen" });
    await userEvent.click(within(prompt).getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText("path /tasks/42")).toBeInTheDocument();
    expect(await screen.findByText("open task 42")).toBeInTheDocument();
    expect(screen.getByText("planner none")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Planung" })).not.toBeInTheDocument();
    expect(api.updateTask).toHaveBeenCalledWith(41, {
      expectedRevision: 1,
      scheduledDate: "2026-10-21",
    });

    await userEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(await screen.findByText("path /tasks/41")).toBeInTheDocument();
    expect(await screen.findByText("open task 41")).toBeInTheDocument();
    expect(screen.getByText("planner none")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Planung" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Browser Forward" }));
    expect(await screen.findByText("path /tasks/42")).toBeInTheDocument();
    expect(await screen.findByText("open task 42")).toBeInTheDocument();
    expect(screen.getByText("planner none")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Planung" })).not.toBeInTheDocument();
  });
});
