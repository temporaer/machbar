import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail, ProjectWithActions } from "../lib/api";
import { ApiError, api } from "../lib/api";
import { useProjectWorkflow } from "../lib/projectWorkflowContext";
import { useRefresh } from "../lib/refresh";
import { useIdentity } from "../lib/identity";
import { renderWithProviders } from "../test/testUtils";
import { makeCriterion, makeMember, makeProject } from "../test/fixtures";
import { ProjectWorkflowHost } from "./ProjectWorkflowHost";

function WorkflowControls() {
  const workflow = useProjectWorkflow();
  const refresh = useRefresh();
  const identity = useIdentity();
  return <>
    <button onClick={() => workflow.open("activateWithDriver", 731)}>Start activation</button>
    <button onClick={() => workflow.open("activateWithDriver", 732)}>Start other activation</button>
    <button onClick={() => workflow.open("editOutcome", 731)}>Edit outcome</button>
    <button onClick={() => workflow.open("convertToTask", 731)}>Convert project</button>
    <button onClick={() => identity.setCurrentMemberId(2)}>Switch member</button>
    <button onClick={refresh.bump}>Refresh project</button>
    <ProjectWorkflowHost />
  </>;
}

function activationDetail(revision = 1, id = 731): ProjectDetail {
  const project = makeProject({
    id,
    title: `Protected project ${id}`,
    status: "backlog",
    revision,
    ownerMemberId: null,
    activationReadiness: {
      ready: false,
      hasDriver: false,
      hasViableProgressPath: false,
      hasHealthyFutureWaiting: false,
      requiredDecisions: ["driver", "progressPath"],
    },
  });
  return {
    ...project,
    tasks: [],
    directActivationDecisionSnapshot: {
      projects: [{
        projectId: id,
        title: project.title,
        revision,
        ownerMemberId: null,
        required: ["driver", "progressPath"],
      }],
      expectedProjects: [{ projectId: id, revision }],
      targetRevision: revision,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function authorChoices(user: ReturnType<typeof userEvent.setup>, title = "Authored activation step") {
  const dialog = await screen.findByRole("dialog");
  await user.selectOptions(await within(dialog).findByLabelText(/Verantwortlich für/), "1");
  await user.type(within(dialog).getByRole("textbox"), title);
  return dialog;
}

function expectTerminal() {
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("alert")).toBeVisible();
  expect(dialog).not.toHaveTextContent("Protected project");
  expect(dialog.querySelectorAll("input, select, textarea")).toHaveLength(0);
  expect(within(dialog).queryByRole("button", { name: "Erneut versuchen" })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "Projekt starten" })).not.toBeInTheDocument();
}

describe("ProjectActivationSheet server-confirmed recovery", () => {
  beforeEach(() => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([
      makeMember({ id: 1, name: "Mira" }),
      makeMember({ id: 2, name: "Ravi" }),
    ]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    });
  });

  it.each([403, 404])("ends private criterion-check mutation %s without retaining protected criteria", async (status) => {
    const project = activationDetail();
    project.acceptanceCriteria = [makeCriterion({ id: 81, text: "Protected criterion" })];
    vi.spyOn(api, "getProject").mockResolvedValue(project);
    vi.spyOn(api, "checkCriterion").mockRejectedValue(new ApiError(status, "Denied"));
    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit outcome" }));
    await user.click(await screen.findByRole("checkbox"));
    await waitFor(expectTerminal);
  });

  it("ends a conversion opening when its private detail read is denied", async () => {
    vi.spyOn(api, "getProject").mockResolvedValueOnce(activationDetail()).mockRejectedValueOnce(new ApiError(403, "Denied"));
    renderWithProviders(<WorkflowControls />);
    await userEvent.click(screen.getByRole("button", { name: "Convert project" }));
    await waitFor(expectTerminal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("can cancel an activation before the initial read completes without reopening on its delayed result", async () => {
    const read = deferred<ProjectDetail>();
    vi.spyOn(api, "getProject").mockReturnValue(read.promise);
    const activate = vi.spyOn(api, "activateProject");
    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    await user.click(await screen.findByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => read.resolve(activationDetail()));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("Protected project");
    expect(activate).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])("ends a revoked opening on read %s and discards its choices", async (status) => {
    const getProject = vi.spyOn(api, "getProject")
      .mockResolvedValueOnce(activationDetail())
      .mockRejectedValueOnce(new ApiError(status, "Denied"))
      .mockResolvedValue(activationDetail(2));
    const activate = vi.spyOn(api, "activateProject");
    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    await authorChoices(user);
    await user.click(screen.getByRole("button", { name: "Refresh project" }));
    await waitFor(expectTerminal);
    await user.click(screen.getByRole("button", { name: "Refresh project" }));
    await waitFor(expectTerminal);
    expect(activate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("textbox")).toHaveValue(""));
    expect(within(dialog).getByRole("combobox")).toHaveValue("");
    expect(getProject).toHaveBeenLastCalledWith(731);
  });

  it.each([403, 404])("shows a terminal reason without inventing fields after initial read %s", async (status) => {
    vi.spyOn(api, "getProject").mockRejectedValue(new ApiError(status, "Denied"));
    renderWithProviders(<WorkflowControls />);
    await userEvent.click(screen.getByRole("button", { name: "Start activation" }));
    await waitFor(expectTerminal);
  });

  it.each([401, 403, 404])("ends the opening immediately after mutation %s", async (status) => {
    vi.spyOn(api, "getProject").mockResolvedValue(activationDetail());
    vi.spyOn(api, "activateProject").mockRejectedValue(new ApiError(status, "Denied"));
    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const dialog = await authorChoices(user);
    await user.click(within(dialog).getByRole("button", { name: "Projekt starten" }));
    await waitFor(expectTerminal);
  });

  it("preserves authored choices across ordinary refresh and mutation network failures", async () => {
    const getProject = vi.spyOn(api, "getProject")
      .mockResolvedValueOnce(activationDetail())
      .mockRejectedValueOnce(new ApiError(503, "Offline"))
      .mockResolvedValue(activationDetail(2));
    const activate = vi.spyOn(api, "activateProject")
      .mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValue(makeProject({ id: 731, status: "active", revision: 3 }));
    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const dialog = await authorChoices(user);
    await user.click(screen.getByRole("button", { name: "Refresh project" }));
    await within(dialog).findByRole("alert");
    expect(within(dialog).getByRole("textbox")).toHaveValue("Authored activation step");
    expect(within(dialog).getByRole("combobox")).toHaveValue("1");
    await user.click(within(dialog).getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(3));
    await user.click(within(dialog).getByRole("button", { name: "Projekt starten" }));
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByRole("textbox")).toHaveValue("Authored activation step");
    expect(within(dialog).getByRole("combobox")).toHaveValue("1");
    await user.click(within(dialog).getByRole("button", { name: "Projekt starten" }));
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
    expect(activate).toHaveBeenLastCalledWith(731, expect.objectContaining({
      expectedRevision: 2,
      activationResolution: {
        expectedProjects: [{ projectId: 731, revision: 2 }],
        drivers: [{ projectId: 731, ownerMemberId: 1 }],
        nextActionTitle: "Authored activation step",
      },
    }));
  });

  it.each(["stale_write_conflict", "project_commitment_resolution_required"] as const)(
    "reloads after %s and requires explicit fresh choices before another submit",
    async (code) => {
      const freshRead = deferred<ProjectDetail>();
      const getProject = vi.spyOn(api, "getProject")
        .mockResolvedValueOnce(activationDetail())
        .mockReturnValueOnce(freshRead.promise)
        .mockResolvedValue(activationDetail(4));
      const activate = vi.spyOn(api, "activateProject")
        .mockRejectedValueOnce(new ApiError(409, "Decisions changed", code, {
          projects: [{ projectId: 999, title: "Obsolete error requirements", revision: 2, ownerMemberId: null, required: ["driver"] }],
          expectedProjects: [{ projectId: 999, revision: 2 }],
        }))
        .mockResolvedValue(makeProject({ id: 731, status: "active", revision: 5 }));
      renderWithProviders(<WorkflowControls />);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Start activation" }));
      const dialog = await authorChoices(user);
      await user.click(within(dialog).getByRole("button", { name: "Projekt starten" }));
      await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(activate).toHaveBeenCalledTimes(1);
      await act(async () => freshRead.resolve(activationDetail(4)));
      expect(await screen.findByRole("textbox")).toHaveValue("");
      const freshDialog = screen.getByRole("dialog");
      expect(within(freshDialog).getByRole("combobox")).toHaveValue("");
      expect(within(freshDialog).getByRole("button", { name: "Projekt starten" })).toBeDisabled();
      expect(document.body).not.toHaveTextContent("Obsolete error requirements");
      expect(activate).toHaveBeenCalledTimes(1);
      await authorChoices(user, "Reconfirmed step");
      await user.click(within(freshDialog).getByRole("button", { name: "Projekt starten" }));
      await waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
      expect(activate).toHaveBeenLastCalledWith(731, expect.objectContaining({
        expectedRevision: 4,
        activationResolution: {
          expectedProjects: [{ projectId: 731, revision: 4 }],
          drivers: [{ projectId: 731, ownerMemberId: 1 }],
          nextActionTitle: "Reconfirmed step",
        },
      }));
    },
  );

  it("reconfirms equal-revision detail with changed ancestor requirements and expected projects", async () => {
    const fresh = activationDetail();
    fresh.ownerMemberId = 1;
    fresh.directActivationDecisionSnapshot = {
      projects: [
        { projectId: 731, title: fresh.title, revision: 1, ownerMemberId: 1, required: ["progressPath"] },
        { projectId: 740, title: "Fresh ancestor requirement", revision: 8, ownerMemberId: null, required: ["driver"] },
      ],
      expectedProjects: [{ projectId: 731, revision: 1 }, { projectId: 740, revision: 8 }],
      targetRevision: 1,
    };
    vi.spyOn(api, "getProject").mockResolvedValueOnce(activationDetail()).mockResolvedValue(fresh);
    const activate = vi.spyOn(api, "activateProject")
      .mockRejectedValueOnce(new ApiError(409, "Stale", "stale_write_conflict"))
      .mockResolvedValue(makeProject({ id: 731, status: "active", revision: 2 }));
    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const original = await authorChoices(user);
    await user.click(within(original).getByRole("button", { name: "Projekt starten" }));
    const driver = await screen.findByLabelText(/Fresh ancestor requirement/);
    expect(driver).toHaveValue("");
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.queryByLabelText(/Verantwortlich für.*Protected project/)).not.toBeInTheDocument();
    expect(activate).toHaveBeenCalledTimes(1);
    await user.selectOptions(driver, "2");
    await user.type(screen.getByRole("textbox"), "Fresh child-aware step");
    await user.click(screen.getByRole("button", { name: "Projekt starten" }));
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
    expect(activate).toHaveBeenLastCalledWith(731, expect.objectContaining({
      expectedRevision: 1,
      ownerMemberId: 1,
      activationResolution: {
        expectedProjects: [{ projectId: 731, revision: 1 }, { projectId: 740, revision: 8 }],
        drivers: [{ projectId: 740, ownerMemberId: 2 }],
        nextActionTitle: "Fresh child-aware step",
      },
    }));
  });

  it("does not restore stale choices when the requirements reload fails", async () => {
    const getProject = vi.spyOn(api, "getProject")
      .mockResolvedValueOnce(activationDetail())
      .mockRejectedValueOnce(new ApiError(503, "Offline"))
      .mockResolvedValue(activationDetail(3));
    const activate = vi.spyOn(api, "activateProject").mockRejectedValue(new ApiError(409, "Stale", "stale_write_conflict"));
    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const dialog = await authorChoices(user);
    await user.click(within(dialog).getByRole("button", { name: "Projekt starten" }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
    const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(activate).toHaveBeenCalledTimes(1);
    await user.click(retry);
    expect(await screen.findByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Projekt starten" })).toBeDisabled();
  });

  it("resets and reloads after a delayed stale command even when a newer read already arrived", async () => {
    const command = deferred<ProjectWithActions>();
    const getProject = vi.spyOn(api, "getProject")
      .mockResolvedValueOnce(activationDetail())
      .mockResolvedValueOnce(activationDetail(3))
      .mockResolvedValue(activationDetail(4));
    const activate = vi.spyOn(api, "activateProject").mockReturnValue(command.promise);
    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const dialog = await authorChoices(user);
    await user.click(within(dialog).getByRole("button", { name: "Projekt starten" }));
    await user.click(screen.getByRole("button", { name: "Refresh project" }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
    await act(async () => command.reject(new ApiError(409, "Old stale error", "stale_write_conflict")));
    await waitFor(() => expect(getProject.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(await screen.findByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "denied", "stale"] as const)("ignores delayed %s from a replaced opening of the same project", async (outcome) => {
    const oldCommand = deferred<ProjectWithActions>();
    vi.spyOn(api, "getProject").mockResolvedValue(activationDetail());
    vi.spyOn(api, "activateProject").mockReturnValue(oldCommand.promise);
    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const oldDialog = await authorChoices(user);
    await user.click(within(oldDialog).getByRole("button", { name: "Projekt starten" }));
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const replacement = await authorChoices(user, "Replacement choice");
    await act(async () => {
      if (outcome === "success") oldCommand.resolve(makeProject({ id: 731, status: "active" }));
      else oldCommand.reject(new ApiError(outcome === "denied" ? 403 : 409, "Obsolete", outcome === "stale" ? "stale_write_conflict" : undefined, {
        projects: [{ projectId: 999, title: "Obsolete opening requirements", revision: 9, ownerMemberId: null, required: ["driver"] }],
        expectedProjects: [{ projectId: 999, revision: 9 }],
      }));
    });
    expect(screen.getByRole("dialog")).toBe(replacement);
    expect(within(replacement).getByRole("textbox")).toHaveValue("Replacement choice");
    expect(within(replacement).queryByRole("alert")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("Obsolete opening requirements");
  });

  it("ignores an obsolete denied read after a different project opens", async () => {
    const oldRead = deferred<ProjectDetail>();
    vi.spyOn(api, "getProject").mockReturnValueOnce(oldRead.promise).mockResolvedValue(activationDetail(1, 732));
    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    await user.click(screen.getByRole("button", { name: "Start other activation" }));
    const replacement = await authorChoices(user, "Other project choice");
    await act(async () => oldRead.reject(new ApiError(403, "Obsolete denial")));
    expect(screen.getByRole("dialog")).toBe(replacement);
    expect(within(replacement).getByRole("textbox")).toHaveValue("Other project choice");
    expect(within(replacement).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps terminal feedback when a denied read and old successful save settle together", async () => {
    const deniedRead = deferred<ProjectDetail>();
    const command = deferred<ProjectWithActions>();
    vi.spyOn(api, "getProject").mockResolvedValueOnce(activationDetail()).mockReturnValueOnce(deniedRead.promise);
    vi.spyOn(api, "activateProject").mockReturnValue(command.promise);
    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const dialog = await authorChoices(user);
    await user.click(within(dialog).getByRole("button", { name: "Projekt starten" }));
    await user.click(screen.getByRole("button", { name: "Refresh project" }));
    await act(async () => {
      deniedRead.reject(new ApiError(403, "Denied"));
      command.resolve(makeProject({ id: 731, status: "active" }));
    });
    await waitFor(expectTerminal);
  });

  it("discards choices and ignores the former member's delayed success after identity changes", async () => {
    const command = deferred<ProjectWithActions>();
    vi.spyOn(api, "getProject").mockResolvedValue(activationDetail());
    vi.spyOn(api, "activateProject").mockReturnValue(command.promise);
    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const dialog = await authorChoices(user);
    await user.click(within(dialog).getByRole("button", { name: "Projekt starten" }));
    await user.click(screen.getByRole("button", { name: "Switch member" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    await act(async () => command.resolve(makeProject({ id: 731, status: "active" })));
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("combobox")).toHaveValue("");
  });
});
