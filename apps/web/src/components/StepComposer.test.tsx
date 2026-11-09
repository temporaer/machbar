import { StrictMode } from "react";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/testUtils";
import { StepComposer } from "./StepComposer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("StepComposer submitted draft ownership", () => {
  it("restores and consumes existing array-form persisted rows after confirmed success", async () => {
    sessionStorage.setItem("machbar:steps:task-7-member-1", JSON.stringify([{ title: "Existing draft", dueDate: "2027-01-15" }]));
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<StepComposer inputIdPrefix="step" label="Steps" placeholder="Step title" submitLabel="Submit steps"
      draftKey="task-7-member-1" onSubmit={onSubmit} />);
    expect(screen.getByPlaceholderText("Step title")).toHaveValue("Existing draft");
    await userEvent.click(screen.getByRole("button", { name: "Submit steps" }));
    await waitFor(() => expect(screen.getByPlaceholderText("Step title")).toHaveValue(""));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith([{ title: "Existing draft", dueDate: "2027-01-15" }]);
    expect(sessionStorage.getItem("machbar:steps:task-7-member-1")).toBeNull();
  });

  it.each(["success", "failure", "preview"] as const)("settles %s after unmount without publishing retired composer callbacks", async outcome => {
    const command = deferred<void | boolean>();
    const onDraftChange = vi.fn();
    const onPendingChange = vi.fn();
    const view = renderWithProviders(<StrictMode><StepComposer inputIdPrefix="step" label="Steps" placeholder="Step title" submitLabel="Submit steps"
      draftKey="project-42-member-1" onSubmit={() => command.promise} onDraftChange={onDraftChange} onPendingChange={onPendingChange} /></StrictMode>);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Step title"), "Submitted step");
    await user.click(screen.getByRole("button", { name: "Submit steps" }));
    const submitted = sessionStorage.getItem("machbar:steps:project-42-member-1");
    expect(submitted).toContain("Submitted step");
    view.unmount();
    onDraftChange.mockClear();
    onPendingChange.mockClear();
    await act(async () => {
      if (outcome === "failure") command.reject(new Error("Offline"));
      else command.resolve(outcome === "preview" ? false : undefined);
    });
    expect(sessionStorage.getItem("machbar:steps:project-42-member-1")).toBe(outcome === "success" ? null : submitted);
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onPendingChange).not.toHaveBeenCalled();
  });
});
