import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { TaskDetailProvider, useTaskDetail } from "../lib/taskDetailContext";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { TaskWorkflowHost } from "../components/TaskWorkflowHost";
import { renderWithProviders } from "../test/testUtils";
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

describe("TaskDeepLinkPage", () => {
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
});
