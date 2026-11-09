import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@machbar/shared";
import { ApiError, api } from "../lib/api";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { useRefresh } from "../lib/refresh";
import { renderWithProviders } from "../test/testUtils";
import { makeCriterion, makeMember, makeTask } from "../test/fixtures";
import { TaskWorkflowHost } from "./TaskWorkflowHost";

function Controls() {
  const workflow = useTaskWorkflow();
  const refresh = useRefresh();
  return <>
    <button onClick={() => workflow.open("completeWithCriteria", 731)}>Open completion</button>
    <button onClick={() => workflow.open("priority", 731)}>Open priority</button>
    <button onClick={() => workflow.open("split", 731)}>Open split</button>
    <button onClick={refresh.bump}>Refresh task</button>
    <TaskWorkflowHost />
  </>;
}

function detail(revision = 1) {
  return makeTask({
    id: 731,
    title: "Protected task title",
    revision,
    acceptanceCriteria: [makeCriterion({ id: 71, text: "Protected criterion" })],
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("TaskWorkflowHost opening recovery", () => {
  beforeEach(() => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1 })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({ enabled: false, authenticated: false, member: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it.each([403, 404])("ends private priority mutation %s even when subsequent reads remain authorized", async (status) => {
    vi.spyOn(api, "getTask").mockResolvedValue(detail());
    vi.spyOn(api, "updateTask").mockRejectedValue(new ApiError(status, "Denied"));
    renderWithProviders(<Controls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open priority" }));
    await user.click(await screen.findByRole("button", { name: "2" }));
    await waitFor(() => expect(screen.getByRole("dialog")).not.toHaveTextContent("Protected"));
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.queryByRole("button", { name: "2" })).not.toBeInTheDocument();
  });

  it.each(["read", "write"] as const)("discards persisted split rows on denied %s and starts a fresh opening empty", async (boundary) => {
    const getTask = vi.spyOn(api, "getTask").mockResolvedValue(detail());
    if (boundary === "read") {
      sessionStorage.setItem("machbar:steps:task-731-member-1", JSON.stringify([{ title: "Protected saved draft" }]));
      getTask.mockRejectedValueOnce(new ApiError(403, "Denied"));
    }
    vi.spyOn(api, "createTaskStepBatchForTask").mockRejectedValue(new ApiError(403, "Denied"));
    renderWithProviders(<Controls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open split" }));
    if (boundary === "write") {
      await user.type(await screen.findByPlaceholderText("Schritt …"), "Protected saved draft");
      await user.click(screen.getByRole("button", { name: "1 Teilaufgabe anlegen" }));
    }
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Protected");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(sessionStorage.getItem("machbar:steps:task-731-member-1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open split" }));
    expect(await screen.findByPlaceholderText("Schritt …")).toHaveValue("");
  });

  it("does not let an obsolete denied split delete the replacement opening's persisted draft", async () => {
    const command = deferred<Awaited<ReturnType<typeof api.createTaskStepBatchForTask>>>();
    vi.spyOn(api, "getTask").mockResolvedValue(detail());
    vi.spyOn(api, "createTaskStepBatchForTask").mockReturnValue(command.promise);
    renderWithProviders(<Controls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open split" }));
    await user.type(await screen.findByPlaceholderText("Schritt …"), "Old pending draft");
    await user.click(screen.getByRole("button", { name: "1 Teilaufgabe anlegen" }));
    await user.click(screen.getByRole("button", { name: "Open split" }));
    const input = (await screen.findAllByPlaceholderText("Schritt …"))[0]!;
    await user.clear(input);
    await user.type(input, "Replacement draft");
    await act(async () => command.reject(new ApiError(403, "Obsolete denial")));
    expect(input).toHaveValue("Replacement draft");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(sessionStorage.getItem("machbar:steps:task-731-member-1")).toContain("Replacement draft");
  });

  it.each([403, 404])("removes protected task fields after refresh %s and discards local completion choices", async (status) => {
    vi.spyOn(api, "getTask")
      .mockResolvedValueOnce(detail())
      .mockRejectedValueOnce(new ApiError(status, "Denied"))
      .mockResolvedValue(detail(2));
    const complete = vi.spyOn(api, "completeTask");
    renderWithProviders(<Controls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open completion" }));
    await user.click(await screen.findByRole("checkbox", { name: "Protected criterion" }));
    await user.click(screen.getByRole("button", { name: "Refresh task" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Protected");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Erneut versuchen" })).not.toBeInTheDocument();
    expect(complete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open completion" }));
    expect(await screen.findByRole("checkbox", { name: "Protected criterion" })).not.toBeChecked();
  });

  it.each([403, 404])("removes protected task fields after completion mutation %s", async (status) => {
    vi.spyOn(api, "getTask").mockResolvedValue(detail());
    vi.spyOn(api, "completeTask").mockRejectedValue(new ApiError(status, "Denied"));
    renderWithProviders(<Controls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open completion" }));
    await user.click(await screen.findByRole("checkbox", { name: "Protected criterion" }));
    await user.click(screen.getByRole("button", { name: "Aufgabe abschließen" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Protected");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("preserves local choices on ordinary refresh failure but not a replacement opening of the same task", async () => {
    vi.spyOn(api, "getTask")
      .mockResolvedValueOnce(detail())
      .mockRejectedValueOnce(new ApiError(503, "Offline"))
      .mockResolvedValue(detail(2));
    renderWithProviders(<Controls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open completion" }));
    await user.click(await screen.findByRole("checkbox", { name: "Protected criterion" }));
    await user.click(screen.getByRole("button", { name: "Refresh task" }));
    expect(screen.getByRole("checkbox")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Open completion" }));
    expect(await screen.findByRole("checkbox", { name: "Protected criterion" })).not.toBeChecked();
  });

  it("resets stale compound completion decisions and requires reconfirmation against fresh requirements", async () => {
    const freshRead = deferred<Task>();
    vi.spyOn(api, "getTask").mockResolvedValueOnce(detail()).mockReturnValueOnce(freshRead.promise).mockResolvedValue(detail(3));
    const complete = vi.spyOn(api, "completeTask").mockRejectedValue(new ApiError(409, "Stale", "stale_write_conflict"));
    renderWithProviders(<Controls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open completion" }));
    await user.click(await screen.findByRole("checkbox", { name: "Protected criterion" }));
    await user.click(screen.getByRole("button", { name: "Aufgabe abschließen" }));
    await waitFor(() => expect(screen.queryByRole("checkbox")).not.toBeInTheDocument());
    expect(complete).toHaveBeenCalledTimes(1);
    await act(async () => freshRead.resolve(detail(3)));
    expect(await screen.findByRole("checkbox", { name: "Protected criterion" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Aufgabe abschließen" })).toBeDisabled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not let a delayed completion close a replacement opening of the same task", async () => {
    const command = deferred<Task>();
    vi.spyOn(api, "getTask").mockResolvedValue(detail());
    vi.spyOn(api, "completeTask").mockReturnValue(command.promise);
    renderWithProviders(<Controls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open completion" }));
    await user.click(await screen.findByRole("checkbox", { name: "Protected criterion" }));
    await user.click(screen.getByRole("button", { name: "Aufgabe abschließen" }));
    await user.click(screen.getByRole("button", { name: "Open completion" }));
    const checkbox = await screen.findByRole("checkbox", { name: "Protected criterion" });
    await act(async () => command.resolve(makeTask({ id: 731, status: "done" })));
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });
});
