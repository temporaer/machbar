import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { TaskDetailProvider, useTaskDetail } from "../lib/taskDetailContext";
import { TaskDeepLinkPage } from "./TaskDeepLinkPage";

function CloseHarness() {
  const { openTaskId, close } = useTaskDetail();
  return (
    <button type="button" onClick={close}>
      close {openTaskId ?? "none"}
    </button>
  );
}

describe("TaskDeepLinkPage", () => {
  it("opens the existing task detail state and returns to Today when it closes", async () => {
    render(
      <MemoryRouter initialEntries={["/aufgaben/42"]}>
        <TaskDetailProvider>
          <CloseHarness />
          <Routes>
            <Route path="/aufgaben/:id" element={<TaskDeepLinkPage />} />
            <Route path="/heute" element={<p>Heute route</p>} />
          </Routes>
        </TaskDetailProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "close 42" })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: "close 42" }));
    expect(await screen.findByText("Heute route")).toBeInTheDocument();
  });
});
