import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMember, makeProject } from "../test/fixtures";
import { ApiError, api } from "../lib/api";
import { useProjectWorkflow } from "../lib/projectWorkflowContext";
import { useRefresh } from "../lib/refresh";
import { renderWithProviders } from "../test/testUtils";
import { ProjectDeadlineSheet } from "./ProjectDeadlineSheet";
import { ProjectWorkflowHost } from "./ProjectWorkflowHost";

function DeadlineWorkflowControls() {
  const workflow = useProjectWorkflow();
  const refresh = useRefresh();
  return <>
    <button onClick={() => workflow.open("deadline", 731)}>Open deadline</button>
    <button onClick={() => workflow.close()}>Retire workflow</button>
    <button onClick={() => { void refresh.bump(); }}>Refresh project</button>
    <ProjectWorkflowHost />
  </>;
}

describe("ProjectDeadlineSheet", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });
  it("saves a deadline directly without activation decisions", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProjectDeadlineSheet story={makeProject({ id: 1, title: "Urlaub", status: "backlog" })} onClose={vi.fn()} onSave={onSave} />);
    const date = screen.getByLabelText("Fällig");
    await userEvent.type(date, "irgendwann vielleicht");
    fireEvent.blur(date);
    expect(screen.getByRole("alert")).toHaveTextContent("Datum nicht erkannt");
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.clear(date);
    await userEvent.type(date, "2026-09-10{Enter}");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ dueDate: "2026-09-10" }));
    expect(screen.queryByLabelText(/Verantwortlich für/)).not.toBeInTheDocument();
  });

  it("retains the date and requests refresh after stale write, then retries explicitly", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new ApiError(409, "Stale", "stale_write_conflict")).mockResolvedValue(undefined);
    const story = makeProject({ id: 1, title: "Urlaub", revision: 1 });
    let finishRefresh!: (value: typeof story) => void;
    const onRefresh = vi.fn(() => new Promise<typeof story>(resolve => { finishRefresh = resolve; }));
    const onClose = vi.fn();
    const view = render(<ProjectDeadlineSheet story={story} onClose={onClose} onSave={onSave} onRefresh={onRefresh} />);
    await userEvent.type(screen.getByLabelText("Fällig"), "2026-12-15{Enter}");
    const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(retry).toBeDisabled();
    view.rerender(<ProjectDeadlineSheet story={{ ...story, revision: 2 }} onClose={onClose} onSave={onSave} onRefresh={onRefresh} />);
    expect(retry).toBeDisabled();
    finishRefresh({ ...story, revision: 2 });
    await waitFor(() => expect(retry).toBeEnabled());
    await userEvent.click(retry);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith({ dueDate: "2026-12-15" });
  });

  it("retains a deadline after an ordinary outage without an automatic second write", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new ApiError(503, "Offline")).mockResolvedValue(undefined);
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<ProjectDeadlineSheet story={makeProject({ id: 1 })} onClose={vi.fn()} onSave={onSave} onRefresh={onRefresh} />);
    await userEvent.type(screen.getByLabelText("Fällig"), "2026-12-15{Enter}");
    const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
    expect(screen.getByLabelText("Fällig")).toHaveValue("15.12.2026");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
    await userEvent.click(retry);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith({ dueDate: "2026-12-15" });
  });

  it("retains a deadline after stale and failed refresh, retrying the read before the write", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new ApiError(409, "Stale", "stale_write_conflict")).mockResolvedValue(undefined);
    const onRefresh = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue({ ...makeProject({ id: 1, revision: 2 }) });
    const story = makeProject({ id: 1, revision: 1 });
    const onClose = vi.fn();
    const view = render(<ProjectDeadlineSheet story={story} onClose={onClose} onSave={onSave} onRefresh={onRefresh} />);
    await userEvent.type(screen.getByLabelText("Fällig"), "2026-12-15{Enter}");
    await screen.findByRole("button", { name: "Erneut versuchen" });
    view.rerender(<ProjectDeadlineSheet story={story} onClose={onClose} onSave={onSave} onRefresh={onRefresh} refreshError="Offline" />);
    expect(screen.getByLabelText("Fällig")).toHaveValue("15.12.2026");
    await userEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenCalledTimes(1);
    view.rerender(<ProjectDeadlineSheet story={{ ...story, revision: 2 }} onClose={onClose} onSave={onSave} onRefresh={onRefresh} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith({ dueDate: "2026-12-15" });
  });

  it("allows explicit retry after a successful reload of the same revision", async () => {
    const story = makeProject({ id: 1, revision: 1 });
    const onSave = vi.fn().mockRejectedValueOnce(new ApiError(409, "Stale", "stale_write_conflict")).mockResolvedValue(undefined);
    const onRefresh = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValue(story);
    const view = render(<ProjectDeadlineSheet story={story} onClose={vi.fn()} onSave={onSave} onRefresh={onRefresh} />);
    await userEvent.type(screen.getByLabelText("Fällig"), "2026-12-15{Enter}");
    const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
    view.rerender(<ProjectDeadlineSheet story={story} onClose={vi.fn()} onSave={onSave} onRefresh={onRefresh} refreshError="Offline" />);
    await userEvent.click(retry);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(retry).toBeEnabled());
    await userEvent.click(retry);
    expect(onSave).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByLabelText("Fällig")).toBeEnabled());
    await userEvent.click(retry);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith({ dueDate: "2026-12-15" });
    expect(onRefresh).toHaveBeenCalledTimes(3);
  });

  it("uses the refreshed revision even before the host renders it", async () => {
    const story = makeProject({ id: 1, revision: 1 });
    const onSave = vi.fn().mockRejectedValueOnce(new ApiError(409, "Stale", "stale_write_conflict")).mockResolvedValue(undefined);
    const onRefresh = vi.fn().mockResolvedValue({ ...story, revision: 2 });
    render(<ProjectDeadlineSheet story={story} onClose={vi.fn()} onSave={onSave} onRefresh={onRefresh} />);
    await userEvent.type(screen.getByLabelText("Fällig"), "2026-12-15{Enter}");
    const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(onSave).toHaveBeenCalledTimes(1);
    await userEvent.click(retry);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith({ dueDate: "2026-12-15", expectedRevision: 2 });
  });

  it.each([1, 2])("recovers through the workflow host after an outage with revision %s", async (revision) => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1 })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({ enabled: false, authenticated: false, member: null });
    const project = { ...makeProject({ id: 731, revision: 1 }), tasks: [] };
    let offline = false;
    vi.spyOn(api, "getProject").mockImplementation(async () => {
      if (offline) throw new ApiError(503, "Offline");
      return { ...project, revision };
    }).mockResolvedValueOnce(project);
    const write = vi.spyOn(api, "updateProject").mockImplementationOnce(async () => {
      offline = true;
      throw new ApiError(409, "Stale", "stale_write_conflict");
    }).mockResolvedValue(project);
    renderWithProviders(<DeadlineWorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open deadline" }));
    await user.type(await screen.findByLabelText("Fällig"), "2026-12-15{Enter}");
    const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(write).toHaveBeenCalledTimes(1);
    await user.click(retry);
    await waitFor(() => expect(retry).toBeEnabled());
    expect(write).toHaveBeenCalledTimes(1);
    offline = false;
    await user.click(retry);
    await waitFor(() => expect(screen.getByLabelText("Fällig")).toBeEnabled());
    expect(write).toHaveBeenCalledTimes(1);
    await user.click(retry);
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write).toHaveBeenLastCalledWith(731, { dueDate: "2026-12-15", expectedRevision: revision });
  });

  it("allows explicit recovery after a background refresh clears the read error", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1 })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({ enabled: false, authenticated: false, member: null });
    const project = { ...makeProject({ id: 731, revision: 1 }), tasks: [] };
    let offline = false;
    vi.spyOn(api, "getProject").mockImplementation(async () => {
      if (offline) throw new Error("Offline");
      return { ...project, revision: 2, dueDate: "2027-01-01" };
    }).mockResolvedValueOnce(project);
    const write = vi.spyOn(api, "updateProject").mockImplementationOnce(async () => {
      offline = true;
      throw new ApiError(409, "Stale", "stale_write_conflict");
    }).mockResolvedValue(project);
    renderWithProviders(<DeadlineWorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open deadline" }));
    await user.type(await screen.findByLabelText("Fällig"), "2026-12-15{Enter}");
    const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
    await screen.findByText("Offline");
    await waitFor(() => expect(retry).toBeEnabled());
    offline = false;
    await user.click(screen.getByRole("button", { name: "Refresh project" }));
    await waitFor(() => expect(screen.queryByText("Offline")).not.toBeInTheDocument());
    await waitFor(() => expect(retry).toBeEnabled());
    expect(screen.getByLabelText("Fällig")).toBeDisabled();
    expect(screen.getByLabelText("Fällig")).toHaveValue("15.12.2026");
    expect(write).toHaveBeenCalledTimes(1);
    await user.click(retry);
    await waitFor(() => expect(screen.getByLabelText("Fällig")).toBeEnabled());
    expect(write).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Fällig")).toHaveValue("15.12.2026");
    await user.click(retry);
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write).toHaveBeenLastCalledWith(731, { dueDate: "2026-12-15", expectedRevision: 2 });
  });

  it.each([403, 404])("ends deadline recovery when the project read returns %s", async (status) => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1 })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({ enabled: false, authenticated: false, member: null });
    const project = { ...makeProject({ id: 731, revision: 1 }), tasks: [] };
    vi.spyOn(api, "getProject").mockResolvedValueOnce(project).mockRejectedValue(new ApiError(status, "Denied"));
    const write = vi.spyOn(api, "updateProject").mockRejectedValue(new ApiError(409, "Stale", "stale_write_conflict"));
    renderWithProviders(<DeadlineWorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open deadline" }));
    await user.type(await screen.findByLabelText("Fällig"), "2026-12-15{Enter}");
    await waitFor(() => expect(screen.queryByLabelText("Fällig")).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Erneut versuchen" })).not.toBeInTheDocument();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not refresh or replay a stale write after its workflow is retired", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1 })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({ enabled: false, authenticated: false, member: null });
    const read = vi.spyOn(api, "getProject").mockResolvedValue({ ...makeProject({ id: 731, revision: 1 }), tasks: [] });
    let rejectWrite!: (cause: unknown) => void;
    const write = vi.spyOn(api, "updateProject").mockImplementation(() => new Promise((_, reject) => { rejectWrite = reject; }));
    renderWithProviders(<DeadlineWorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open deadline" }));
    await user.type(await screen.findByLabelText("Fällig"), "2026-12-15{Enter}");
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Retire workflow" }));
    await act(async () => rejectWrite(new ApiError(409, "Stale", "stale_write_conflict")));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not apply a retired reload to a replacement deadline workflow", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1 })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({ enabled: false, authenticated: false, member: null });
    const project = { ...makeProject({ id: 731, revision: 1 }), tasks: [] };
    let holdReads = false;
    const finishReads: Array<(value: typeof project) => void> = [];
    const read = vi.spyOn(api, "getProject").mockImplementation(() =>
      holdReads ? new Promise(resolve => { finishReads.push(resolve); }) : Promise.resolve(project));
    const write = vi.spyOn(api, "updateProject").mockImplementation(async () => {
      holdReads = true;
      throw new ApiError(409, "Stale", "stale_write_conflict");
    });
    renderWithProviders(<DeadlineWorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open deadline" }));
    await user.type(await screen.findByLabelText("Fällig"), "2026-12-15{Enter}");
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1));
    expect(finishReads.length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Retire workflow" }));
    holdReads = false;
    await user.click(screen.getByRole("button", { name: "Open deadline" }));
    expect(await screen.findByLabelText("Fällig")).toHaveValue("");
    await act(async () => finishReads.forEach(finish => finish({ ...project, revision: 2 })));
    expect(screen.getByLabelText("Fällig")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Erneut versuchen" })).not.toBeInTheDocument();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
