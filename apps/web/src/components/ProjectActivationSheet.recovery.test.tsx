import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail, ProjectWithActions } from "../lib/api";
import { ApiError, api } from "../lib/api";
import { useProjectWorkflow } from "../lib/projectWorkflowContext";
import { useRefresh } from "../lib/refresh";
import { renderWithProviders } from "../test/testUtils";
import { makeMember, makeProject } from "../test/fixtures";
import { ProjectWorkflowHost } from "./ProjectWorkflowHost";

function WorkflowControls() {
  const workflow = useProjectWorkflow();
  const refresh = useRefresh();
  return (
    <>
      <button onClick={() => workflow.open("activateWithDriver", 731)}>Start activation</button>
      <button onClick={() => workflow.open("activateWithDriver", 732)}>Start other activation</button>
      <button onClick={refresh.bump}>Refresh project</button>
      <ProjectWorkflowHost />
    </>
  );
}

function activationDetail(
  overrides: Partial<ProjectDetail> = {},
  projectId = 731,
  title = "Protected activation title",
): ProjectDetail {
  const project = makeProject({
    id: projectId,
    title,
    status: "backlog",
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
        projectId,
        title: project.title,
        revision: project.revision,
        ownerMemberId: null,
        required: ["driver", "progressPath"],
      }],
      expectedProjects: [{ projectId: project.id, revision: project.revision }],
      targetRevision: project.revision,
    },
    ...overrides,
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

describe("ProjectActivationSheet read recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("removes revoked project requirements from the DOM while retaining authored choices", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    });
    const getProject = vi.spyOn(api, "getProject")
      .mockResolvedValueOnce(activationDetail())
      .mockRejectedValueOnce(new ApiError(403, "Access denied."))
      .mockRejectedValueOnce(new ApiError(503, "Temporarily unavailable."))
      .mockResolvedValueOnce(activationDetail({
        title: "Fresh activation title",
        revision: 2,
        directActivationDecisionSnapshot: {
          projects: [{
            projectId: 731,
            title: "Fresh activation title",
            revision: 2,
            ownerMemberId: null,
            required: ["driver", "progressPath"],
          }],
          expectedProjects: [{ projectId: 731, revision: 2 }],
          targetRevision: 2,
        },
      }))
      .mockRejectedValueOnce(new ApiError(503, "Temporarily unavailable."))
      .mockResolvedValue(activationDetail({
        title: "Fresh activation title",
        revision: 2,
        directActivationDecisionSnapshot: {
          projects: [{
            projectId: 731,
            title: "Fresh activation title",
            revision: 2,
            ownerMemberId: null,
            required: ["driver", "progressPath"],
          }],
          expectedProjects: [{ projectId: 731, revision: 2 }],
          targetRevision: 2,
        },
      }));
    const activateProject = vi.spyOn(api, "activateProject").mockResolvedValue(
      makeProject({ id: 731, title: "Fresh activation title", status: "active", revision: 3 }),
    );

    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const dialog = await screen.findByRole("dialog");
    await screen.findByRole("option", { name: "Mira" });
    await user.selectOptions(within(dialog).getByLabelText(/Verantwortlich für/), "1");
    const nextAction = dialog.querySelector<HTMLInputElement>("#commitment-next-action");
    expect(nextAction).not.toBeNull();
    await user.type(nextAction!, "Authored activation step");

    await user.click(screen.getByRole("button", { name: "Refresh project" }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
    const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
    expect(document.body).not.toHaveTextContent("Protected activation title");
    expect(document.body).not.toHaveTextContent("Authored activation step");
    expect(document.querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect(activateProject).not.toHaveBeenCalled();

    await user.click(retry);
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(3));
    expect(document.body).not.toHaveTextContent("Protected activation title");
    expect(document.querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect(activateProject).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(screen.getByText("Fresh activation title")).toBeInTheDocument());
    const recoveredDialog = screen.getByRole("dialog");
    expect(within(recoveredDialog).getByLabelText(/Verantwortlich für/)).toHaveValue("1");
    expect(recoveredDialog.querySelector<HTMLInputElement>("#commitment-next-action")).toHaveValue(
      "Authored activation step",
    );
    expect(activateProject).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Refresh project" }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(5));
    expect(within(recoveredDialog).getByRole("alert")).toBeVisible();
    expect(within(recoveredDialog).getByRole("alert")).toHaveTextContent("Etwas ist schiefgelaufen");
    expect(within(recoveredDialog).getByRole("button", { name: "Erneut versuchen" })).toBeVisible();
    expect(within(recoveredDialog).getByRole("button", { name: "Abbrechen" })).toBeEnabled();
    expect(within(recoveredDialog).getByText("Fresh activation title")).toBeVisible();
    expect(recoveredDialog.querySelector<HTMLInputElement>("#commitment-next-action")).toHaveValue(
      "Authored activation step",
    );
    await user.click(within(recoveredDialog).getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(6));
    expect(within(recoveredDialog).queryByRole("alert")).not.toBeInTheDocument();

    await user.click(within(recoveredDialog).getByRole("button", { name: /^Projekt starten$/ }));
    await waitFor(() => expect(activateProject).toHaveBeenCalledTimes(1));
    expect(activateProject).toHaveBeenCalledWith(731, expect.objectContaining({
      expectedRevision: 2,
      activationResolution: {
        expectedProjects: [{ projectId: 731, revision: 2 }],
        drivers: [{ projectId: 731, ownerMemberId: 1 }],
        nextActionTitle: "Authored activation step",
      },
    }));
  });

  it.each(["required", "assigned"] as const)("keeps server-updated requirements authoritative while editing, with the later driver %s", async (laterDriver) => {
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
    const getProject = vi.spyOn(api, "getProject")
      .mockResolvedValueOnce(activationDetail({
        title: "Original activation title",
        revision: 1,
        directActivationDecisionSnapshot: {
          projects: [{
            projectId: 731,
            title: "Original activation title",
            revision: 1,
            ownerMemberId: null,
            required: ["driver"],
          }],
          expectedProjects: [{ projectId: 731, revision: 1 }],
          targetRevision: 1,
        },
      }, 731, "Original activation title"))
      .mockResolvedValue(activationDetail({
        title: "Latest readable requirements",
        revision: 3,
        ownerMemberId: laterDriver === "assigned" ? 1 : null,
        directActivationDecisionSnapshot: {
          projects: [{
            projectId: 731,
            title: "Latest readable requirements",
            revision: 3,
            ownerMemberId: laterDriver === "assigned" ? 1 : null,
            required: laterDriver === "assigned" ? ["progressPath"] : ["driver", "progressPath"],
          }],
          expectedProjects: [{ projectId: 731, revision: 3 }],
          targetRevision: 3,
        },
      }, 731, "Latest readable requirements"));
    const activateProject = vi.spyOn(api, "activateProject")
      .mockRejectedValueOnce(new ApiError(409, "Decisions changed.", "project_commitment_resolution_required", {
        projects: [{
          projectId: 731,
          title: "Updated server requirements",
          revision: 2,
          ownerMemberId: null,
          required: ["driver", "progressPath"],
        }],
        expectedProjects: [{ projectId: 731, revision: 2 }],
        targetRevision: 2,
      }))
      .mockRejectedValueOnce(new ApiError(503, "Temporarily unavailable."))
      .mockResolvedValue(makeProject({
        id: 731,
        title: "Latest readable requirements",
        status: "active",
        revision: 4,
      }));

    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const dialog = await screen.findByRole("dialog");
    await screen.findByRole("option", { name: "Mira" });
    await user.selectOptions(within(dialog).getByLabelText(/Verantwortlich für/), "1");
    await user.click(within(dialog).getByRole("button", { name: /^Projekt starten$/ }));
    await waitFor(() => expect(activateProject).toHaveBeenCalledTimes(1));

    const latestDriver = await within(dialog).findByLabelText(/Updated server requirements/);
    expect(dialog.querySelector<HTMLInputElement>("#commitment-next-action")).not.toBeNull();
    await user.selectOptions(latestDriver, "2");
    expect(within(dialog).getByLabelText(/Updated server requirements/)).toHaveValue("2");
    const nextAction = dialog.querySelector<HTMLInputElement>("#commitment-next-action")!;
    await user.type(nextAction, "Authored after server update");

    expect(within(dialog).getByLabelText(/Updated server requirements/)).toHaveValue("2");
    expect(nextAction).toHaveValue("Authored after server update");
    expect(getProject).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole("button", { name: /^Projekt starten$/ }));
    await waitFor(() => expect(activateProject).toHaveBeenCalledTimes(2));
    expect(activateProject).toHaveBeenLastCalledWith(731, expect.objectContaining({
      expectedRevision: 2,
      activationResolution: {
        expectedProjects: [{ projectId: 731, revision: 2 }],
        drivers: [{ projectId: 731, ownerMemberId: 2 }],
        nextActionTitle: "Authored after server update",
      },
    }));
    await user.click(screen.getByRole("button", { name: "Refresh project" }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).queryByLabelText(/Updated server requirements/)).not.toBeInTheDocument());
    if (laterDriver === "required") {
      expect(within(dialog).getByLabelText(/Latest readable requirements/)).toHaveValue("2");
    } else {
      expect(within(dialog).queryByLabelText(/Latest readable requirements/)).not.toBeInTheDocument();
    }
    expect(dialog.querySelector<HTMLInputElement>("#commitment-next-action")).toHaveValue(
      "Authored after server update",
    );

    await user.click(within(dialog).getByRole("button", { name: /^Projekt starten$/ }));
    await waitFor(() => expect(activateProject).toHaveBeenCalledTimes(3));
    expect(activateProject).toHaveBeenLastCalledWith(731, expect.objectContaining({
      expectedRevision: 3,
      activationResolution: {
        expectedProjects: [{ projectId: 731, revision: 3 }],
        drivers: laterDriver === "assigned" ? [] : [{ projectId: 731, ownerMemberId: 2 }],
        nextActionTitle: "Authored after server update",
      },
    }));
    if (laterDriver === "assigned") {
      expect(activateProject.mock.calls.at(-1)?.[1]?.ownerMemberId).not.toBe(2);
    }
  });

  it("keeps an empty opening recoverable after initial denial without inventing a project", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    });
    const getProject = vi.spyOn(api, "getProject")
      .mockRejectedValueOnce(new ApiError(403, "Access denied."))
      .mockRejectedValueOnce(new ApiError(503, "Temporarily unavailable."))
      .mockResolvedValue(activationDetail());
    const activateProject = vi.spyOn(api, "activateProject");

    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const dialog = await screen.findByRole("dialog");
    await screen.findByRole("button", { name: "Erneut versuchen" });
    expect(dialog).toBe(screen.getByRole("dialog"));
    expect(document.body).not.toHaveTextContent("Protected activation title");
    expect(dialog.querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect(activateProject).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
    expect(document.body).not.toHaveTextContent("Protected activation title");
    expect(activateProject).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(screen.getByText("Protected activation title")).toBeInTheDocument());
    expect(dialog).toBe(screen.getByRole("dialog"));
    expect(getProject).toHaveBeenCalledTimes(3);
    expect(activateProject).not.toHaveBeenCalled();
  });

  it.each(["503", "403"] as const)(
    "publishes an accepted retry before a queued %s",
    async (trailingStatus) => {
      window.localStorage.setItem("machbar:identity-member-id", "1");
      vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
      vi.spyOn(api, "getAuthStatus").mockResolvedValue({
        enabled: false,
        authenticated: false,
        member: null,
      });
      const acceptedRetry = deferred<ProjectDetail>();
      const trailingRead = deferred<ProjectDetail>();
      const currentDetail = activationDetail({
        title: "Current queued snapshot",
        revision: 2,
        directActivationDecisionSnapshot: {
          projects: [{
            projectId: 731,
            title: "Current queued snapshot",
            revision: 2,
            ownerMemberId: null,
            required: ["driver", "progressPath"],
          }],
          expectedProjects: [{ projectId: 731, revision: 2 }],
          targetRevision: 2,
        },
      });
      const getProject = vi.spyOn(api, "getProject")
        .mockResolvedValueOnce(activationDetail())
        .mockRejectedValueOnce(new ApiError(403, "Access denied."))
        .mockReturnValueOnce(acceptedRetry.promise)
        .mockReturnValueOnce(trailingRead.promise);
      const activateProject = vi.spyOn(api, "activateProject");

      renderWithProviders(<WorkflowControls />);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Start activation" }));
      const dialog = await screen.findByRole("dialog");
      await screen.findByRole("option", { name: "Mira" });
      await user.selectOptions(within(dialog).getByLabelText(/Verantwortlich für/), "1");
      await user.type(dialog.querySelector<HTMLInputElement>("#commitment-next-action")!, "Retained queued draft");

      await user.click(screen.getByRole("button", { name: "Refresh project" }));
      await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
      await user.click(await screen.findByRole("button", { name: "Erneut versuchen" }));
      await waitFor(() => expect(getProject).toHaveBeenCalledTimes(3));
      await user.click(screen.getByRole("button", { name: "Refresh project" }));
      await act(async () => acceptedRetry.resolve(currentDetail));
      await waitFor(() => expect(getProject).toHaveBeenCalledTimes(4));

      await act(async () => {
        if (trailingStatus === "403") {
          trailingRead.reject(new ApiError(403, "Access denied."));
        } else {
          trailingRead.reject(new ApiError(503, "Temporarily unavailable."));
        }
      });

      expect(activateProject).not.toHaveBeenCalled();
      expect(within(dialog).getByRole("button", { name: "Erneut versuchen" })).toBeVisible();
      if (trailingStatus === "503") {
        expect(within(dialog).getByText("Current queued snapshot")).toBeVisible();
        expect(within(dialog).getByLabelText(/Verantwortlich für/)).toHaveValue("1");
        expect(dialog.querySelector<HTMLInputElement>("#commitment-next-action")).toHaveValue(
          "Retained queued draft",
        );
        expect(within(dialog).getByRole("alert")).toBeVisible();
      } else {
        expect(dialog).not.toHaveTextContent("Current queued snapshot");
        expect(document.querySelectorAll("input, select, textarea")).toHaveLength(0);
      }
    },
  );

  it("isolates a replacement opening and ignores an obsolete activation response", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    });
    const getProject = vi.spyOn(api, "getProject")
      .mockResolvedValueOnce(activationDetail())
      .mockResolvedValue(activationDetail({ title: "Project B" }, 732, "Project B"));
    let resolveActivation!: (project: ProjectWithActions) => void;
    const pendingActivation = new Promise<ProjectWithActions>((resolve) => {
      resolveActivation = resolve;
    });
    const activateProject = vi.spyOn(api, "activateProject").mockReturnValue(pendingActivation);

    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const firstDialog = await screen.findByRole("dialog");
    await screen.findByRole("option", { name: "Mira" });
    await user.selectOptions(within(firstDialog).getByLabelText(/Verantwortlich für/), "1");
    await user.type(firstDialog.querySelector<HTMLInputElement>("#commitment-next-action")!, "A only");
    await user.click(within(firstDialog).getByRole("button", { name: /^Projekt starten$/ }));
    await waitFor(() => expect(activateProject).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Start other activation" }));
    const secondDialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(secondDialog).getByText("Project B")).toBeInTheDocument());
    expect(secondDialog.querySelector<HTMLInputElement>("#commitment-next-action")).toHaveValue("");
    expect(within(secondDialog).getByLabelText(/Verantwortlich für/)).toHaveValue("");

    resolveActivation(makeProject({ id: 731, title: "Protected activation title", status: "active", revision: 2 }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("dialog")).toBe(secondDialog);
    expect(within(secondDialog).getByText("Project B")).toBeInTheDocument();
    expect(secondDialog.querySelector<HTMLInputElement>("#commitment-next-action")).toHaveValue("");
  });

  it("does not publish an expired command error after same-opening read recovery", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    });
    const failedRetry = deferred<ProjectDetail>();
    const getProject = vi.spyOn(api, "getProject")
      .mockResolvedValueOnce(activationDetail())
      .mockRejectedValueOnce(new ApiError(403, "Access denied."))
      .mockReturnValueOnce(failedRetry.promise)
      .mockResolvedValue(activationDetail({
        title: "Current activation title",
        revision: 2,
        directActivationDecisionSnapshot: {
          projects: [{
            projectId: 731,
            title: "Current activation title",
            revision: 2,
            ownerMemberId: null,
            required: ["driver"],
          }],
          expectedProjects: [{ projectId: 731, revision: 2 }],
          targetRevision: 2,
        },
      }));
    const activation = deferred<ProjectWithActions>();
    const activateProject = vi.spyOn(api, "activateProject").mockReturnValue(activation.promise);

    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const dialog = await screen.findByRole("dialog");
    await screen.findByRole("option", { name: "Mira" });
    await user.selectOptions(within(dialog).getByLabelText(/Verantwortlich für/), "1");
    await user.type(dialog.querySelector<HTMLInputElement>("#commitment-next-action")!, "Draft before save");
    await user.click(within(dialog).getByRole("button", { name: /^Projekt starten$/ }));
    await waitFor(() => expect(activateProject).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Refresh project" }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
    const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
    expect(retry).toBeEnabled();

    await user.click(retry);
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(3));
    expect(within(dialog).getByRole("status")).toHaveTextContent("Lädt");
    expect(within(dialog).getByRole("button", { name: "Abbrechen" })).toBeDisabled();
    await act(async () => {
      failedRetry.reject(new ApiError(503, "Temporarily unavailable."));
    });
    await user.click(await screen.findByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(screen.getByText("Current activation title")).toBeInTheDocument());
    expect(dialog.querySelector("#commitment-next-action")).toBeNull();

    activation.reject(new ApiError(409, "Decisions changed.", "project_commitment_resolution_required", {
      projects: [{
        projectId: 731,
        title: "Expired error snapshot",
        revision: 1,
        ownerMemberId: null,
        required: ["driver", "progressPath"],
      }],
      expectedProjects: [{ projectId: 731, revision: 1 }],
      targetRevision: 1,
    }));
    await waitFor(() => expect(dialog).toContainElement(
      within(dialog).getByLabelText(/Verantwortlich für/),
    ));
    expect(dialog).not.toHaveTextContent("Expired error snapshot");
    expect(dialog.querySelector("#commitment-next-action")).toBeNull();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(getProject).toHaveBeenCalledTimes(4);
    expect(activateProject).toHaveBeenCalledTimes(1);
  });

  it("does not close or restore old requirements after same-opening read recovery and delayed success", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    });
    const currentDetail = activationDetail({
      title: "Current activation title",
      revision: 3,
      directActivationDecisionSnapshot: {
        projects: [{
          projectId: 731,
          title: "Current activation title",
          revision: 3,
          ownerMemberId: null,
          required: ["driver"],
        }],
        expectedProjects: [{ projectId: 731, revision: 3 }],
        targetRevision: 3,
      },
    });
    const freshReadRevisions: number[] = [];
    const getProject = vi.spyOn(api, "getProject")
      .mockResolvedValueOnce(activationDetail({
        title: "Original activation title",
        revision: 1,
        directActivationDecisionSnapshot: {
          projects: [{
            projectId: 731,
            title: "Original activation title",
            revision: 1,
            ownerMemberId: null,
            required: ["driver", "progressPath"],
          }],
          expectedProjects: [{ projectId: 731, revision: 1 }],
          targetRevision: 1,
        },
      }, 731, "Original activation title"))
      .mockRejectedValueOnce(new ApiError(403, "Access denied."))
      .mockRejectedValueOnce(new ApiError(503, "Temporarily unavailable."))
      .mockImplementation(async () => {
        freshReadRevisions.push(currentDetail.revision);
        return currentDetail;
      });
    const activation = deferred<ProjectWithActions>();
    const activateProject = vi.spyOn(api, "activateProject").mockReturnValue(activation.promise);

    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(await within(dialog).findByLabelText(/Verantwortlich für/), "1");
    await user.type(dialog.querySelector<HTMLInputElement>("#commitment-next-action")!, "Authored old step");
    await user.click(within(dialog).getByRole("button", { name: /^Projekt starten$/ }));
    await waitFor(() => expect(activateProject).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Refresh project" }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
    await user.click(await screen.findByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(3));
    await user.click(await screen.findByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(screen.getByText("Current activation title")).toBeInTheDocument());
    expect(within(dialog).getByLabelText(/Verantwortlich für/)).toHaveValue("1");
    expect(dialog.querySelector("#commitment-next-action")).toBeNull();

    await act(async () => {
      activation.resolve(makeProject({
        id: 731,
        title: "Original activation title",
        status: "active",
        revision: 2,
      }));
      await activation.promise;
    });
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(within(dialog).getByText("Current activation title")).toBeVisible();
    });
    expect(within(dialog).getByLabelText(/Verantwortlich für/)).toHaveValue("1");
    expect(dialog.querySelector("#commitment-next-action")).toBeNull();
    expect(dialog).not.toHaveTextContent("Original activation title");
    expect(activateProject).toHaveBeenCalledTimes(1);
    expect(freshReadRevisions.length).toBeGreaterThan(0);
    expect(freshReadRevisions.every((revision) => revision === 3)).toBe(true);
  });

  it("keeps the opening current when a save settles in the same batch as read denial", async () => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.spyOn(api, "getMembers").mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    vi.spyOn(api, "getAuthStatus").mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    });
    const deniedRead = deferred<ProjectDetail>();
    const currentDetail = activationDetail({
      title: "Current activation title",
      revision: 3,
      directActivationDecisionSnapshot: {
        projects: [{
          projectId: 731,
          title: "Current activation title",
          revision: 3,
          ownerMemberId: null,
          required: ["driver"],
        }],
        expectedProjects: [{ projectId: 731, revision: 3 }],
        targetRevision: 3,
      },
    });
    const freshReadRevisions: number[] = [];
    const getProject = vi.spyOn(api, "getProject")
      .mockResolvedValueOnce(activationDetail({
        title: "Original activation title",
        revision: 1,
      }, 731, "Original activation title"))
      .mockReturnValueOnce(deniedRead.promise)
      .mockImplementation(async () => {
        freshReadRevisions.push(currentDetail.revision);
        return currentDetail;
      });
    const activation = deferred<ProjectWithActions>();
    const activateProject = vi.spyOn(api, "activateProject").mockReturnValue(activation.promise);

    renderWithProviders(<WorkflowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start activation" }));
    const dialog = await screen.findByRole("dialog");
    await screen.findByRole("option", { name: "Mira" });
    await user.selectOptions(within(dialog).getByLabelText(/Verantwortlich für/), "1");
    await user.type(dialog.querySelector<HTMLInputElement>("#commitment-next-action")!, "Authored activation step");
    await user.click(within(dialog).getByRole("button", { name: /^Projekt starten$/ }));
    await waitFor(() => expect(activateProject).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Refresh project" }));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
    await act(async () => {
      deniedRead.reject(new ApiError(403, "Access denied."));
      await Promise.resolve();
      await Promise.resolve();
      activation.resolve(makeProject({
        id: 731,
        title: "Original activation title",
        status: "active",
        revision: 2,
      }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog).not.toHaveTextContent("Original activation title");
    expect(dialog).not.toHaveTextContent("Expired error snapshot");
    expect(activateProject).toHaveBeenCalledTimes(1);
    expect(freshReadRevisions.every((revision) => revision === 3)).toBe(true);
  });
});
