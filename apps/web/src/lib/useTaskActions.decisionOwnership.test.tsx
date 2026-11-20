import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildPolicyPrompt } from "../components/ChildPolicyPrompt";
import { ViewCompletionNotice } from "../components/ViewCompletionNotice";
import { makeTask } from "../test/fixtures";
import { LocaleProvider } from "./locale";
import { RefreshProvider } from "./refresh";
import {
  CompletionFeedbackOwnerProvider,
  TaskActionsProvider,
  TaskCommandEligibilityProvider,
  useTaskActions,
  useTaskCommandEligibility,
  type TaskCommandEligibility,
} from "./useTaskActions";
import { api, ApiError } from "./api";

vi.mock("./api", async importOriginal => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, completeTask: vi.fn(), cancelTask: vi.fn() } };
});

const mockedApi = vi.mocked(api, true);
const parent = makeTask({
  id: 1,
  status: "actionable",
  children: [makeTask({ id: 11, parentTaskId: 1, status: "actionable" })],
});
const recoverableTask = makeTask({
  id: 20,
  title: "Recovered task",
  status: "actionable",
  children: [],
});
const accessResource = { type: "view" as const, key: "completion-recovery" };

let actionsByScope = new Map<symbol, ReturnType<typeof useTaskActions>>();

function DecisionHarness({
  scope,
  request,
}: {
  scope: TaskCommandEligibility;
  request: "complete" | "cancel";
}) {
  const actions = useTaskActions();
  actionsByScope.set(scope.id, actions);
  return (
    <>
      <button
        type="button"
        onClick={() => request === "complete" ? actions.requestToggle(parent) : actions.requestCancel(parent)}
      >
        Request {request}
      </button>
      {actions.pendingTask &&
      actions.pendingCommandEligibilityId === scope.id ? (
        <ChildPolicyPrompt
          taskTitle={actions.pendingTask.title}
          action={actions.pendingAction ?? "complete"}
          onChoose={actions.resolvePolicy}
          onClose={actions.cancelPrompt}
        />
      ) : null}
    </>
  );
}

function Scope({
  scope,
  owner,
  request = "complete",
}: {
  scope: TaskCommandEligibility;
  owner: symbol;
  request?: "complete" | "cancel";
}) {
  return (
    <CompletionFeedbackOwnerProvider owner={owner}>
      <TaskCommandEligibilityProvider scope={scope}>
        <DecisionHarness scope={scope} request={request} />
      </TaskCommandEligibilityProvider>
    </CompletionFeedbackOwnerProvider>
  );
}

function renderScopes(scopes: Array<{
  scope: TaskCommandEligibility;
  owner: symbol;
  request?: "complete" | "cancel";
}>) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <LocaleProvider initialLocale="de">
        <RefreshProvider>
          <TaskActionsProvider>{children}</TaskActionsProvider>
        </RefreshProvider>
      </LocaleProvider>
    );
  }
  actionsByScope = new Map();
  return render(scopes.map(({ scope, owner, request }, index) => (
    <Scope key={index} scope={scope} owner={owner} {...(request ? { request } : {})} />
  )), {
    wrapper: Wrapper,
  });
}

function AccessRecoveryControls({
  readState,
  denyAccess,
  retryAccess,
}: {
  readState: "loading" | "unavailable" | "available";
  denyAccess: () => void;
  retryAccess: () => void;
}) {
  const actions = useTaskActions();
  const commandEligibility = useTaskCommandEligibility();
  return (
    <>
      <output>{readState}</output>
      <output>{commandEligibility?.active ? "commands-enabled" : "commands-disabled"}</output>
      <button type="button" onClick={denyAccess}>Deny access</button>
      <button type="button" onClick={retryAccess}>Retry access</button>
      <button type="button" onClick={() => actions.requestToggle(recoverableTask)}>
        Complete recovered task
      </button>
    </>
  );
}

function AccessRecoveryHarness() {
  const failNextRead = useRef(false);
  const read = useQuery({
    queryKey: ["read", "completion-recovery"],
    meta: { accessResource },
    queryFn: async () => {
      if (failNextRead.current) {
        failNextRead.current = false;
        throw new ApiError(403, "Access denied");
      }
      return true;
    },
  });
  return (
    <ViewCompletionNotice
      accessResource={accessResource}
      enabled
      readUnavailable={read.isError}
    >
      <AccessRecoveryControls
        readState={read.isError ? "unavailable" : read.isSuccess ? "available" : "loading"}
        denyAccess={() => {
          failNextRead.current = true;
          void read.refetch();
        }}
        retryAccess={() => void read.refetch()}
      />
    </ViewCompletionNotice>
  );
}
describe("child-policy command eligibility", () => {
  afterEach(() => vi.clearAllMocks());

  it("retires the old owner and registers fresh feedback after view access recovers", async () => {
    let commitFirstCompletion!: (task: typeof recoverableTask) => void;
    mockedApi.completeTask
      .mockImplementationOnce(() => new Promise(resolve => {
        commitFirstCompletion = resolve;
      }))
      .mockResolvedValueOnce(recoverableTask);
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <LocaleProvider initialLocale="de">
          <RefreshProvider>
            <TaskActionsProvider>{children}</TaskActionsProvider>
          </RefreshProvider>
        </LocaleProvider>
      );
    }

    render(<AccessRecoveryHarness />, { wrapper: Wrapper });
    await screen.findByText("available");
    await screen.findByText("commands-enabled");
    await userEvent.click(screen.getByRole("button", { name: "Complete recovered task" }));
    await waitFor(() => expect(mockedApi.completeTask).toHaveBeenCalledOnce());

    await userEvent.click(await screen.findByRole("button", { name: "Deny access" }));
    await screen.findByText("unavailable");
    await screen.findByText("commands-disabled");
    await userEvent.click(screen.getByRole("button", { name: "Retry access" }));
    await screen.findByText("available");

    await act(async () => {
      commitFirstCompletion(recoverableTask);
    });
    expect(screen.queryByText("„Recovered task“ erledigt.")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Complete recovered task" }));

    expect(mockedApi.completeTask).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("„Recovered task“ erledigt.")).toBeVisible();
  });

  it.each([
    ["complete", "complete_children"],
    ["cancel", "cancel_children"],
  ] as const)("rejects a portalled %s decision if its read becomes unavailable", async (action, policy) => {
    const scope = { id: Symbol("view"), active: true };
    renderScopes([{ scope, owner: Symbol("feedback"), request: action }]);
    await userEvent.click(screen.getByRole("button", { name: `Request ${action}` }));
    expect(await screen.findByRole("dialog", { name: "Diese Aufgabe hat offene Teilaufgaben." })).toBeVisible();

    act(() => { scope.active = false; });
    await userEvent.click(screen.getByRole("button", {
      name: action === "complete" ? /Teilaufgaben ebenfalls erledigen/ : /Teilaufgaben verwerfen/,
    }));

    expect(mockedApi.completeTask).not.toHaveBeenCalled();
    expect(mockedApi.cancelTask).not.toHaveBeenCalled();
    expect(actionsByScope.get(scope.id)?.pendingTask).toBeNull();
  });

  it("does not let one view retire or resolve another view's decision", async () => {
    const first = { id: Symbol("first-view"), active: true };
    const second = { id: Symbol("second-view"), active: true };
    renderScopes([
      { scope: first, owner: Symbol("first-feedback") },
      { scope: second, owner: Symbol("second-feedback") },
    ]);

    await userEvent.click(screen.getAllByRole("button", { name: "Request complete" })[0]!);
    act(() => {
      second.active = false;
      actionsByScope.get(second.id)?.retirePendingDecisions(second);
      actionsByScope.get(second.id)?.resolvePolicy("complete_children");
    });

    expect(mockedApi.completeTask).not.toHaveBeenCalled();
    expect(actionsByScope.get(first.id)?.pendingTask).toBe(parent);
    await act(async () => actionsByScope.get(first.id)?.resolvePolicy("complete_children"));
    expect(mockedApi.completeTask).toHaveBeenCalledTimes(1);
    expect(actionsByScope.get(first.id)?.pendingTask).toBeNull();
  });

  it("rejects completion requests made after the originating view becomes unavailable", async () => {
    const scope = { id: Symbol("view"), active: false };
    renderScopes([{ scope, owner: Symbol("feedback") }]);

    act(() => actionsByScope.get(scope.id)?.requestToggle(parent));
    await expect(
      actionsByScope.get(scope.id)!.complete(parent, undefined, undefined, true),
    ).rejects.toThrow("Bitte aktualisiere die Ansicht, bevor du diese Aufgabe abschließt.");

    expect(actionsByScope.get(scope.id)?.pendingTask).toBeNull();
    expect(mockedApi.completeTask).not.toHaveBeenCalled();
  });
});
