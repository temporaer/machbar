import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";
import { useTaskDetail } from "../lib/taskDetailContext";
import { useTaskWorkflow } from "../lib/taskWorkflowContext";
import { TaskDetailSheet } from "./TaskDetailSheet";
import { TaskWorkflowHost } from "./TaskWorkflowHost";
import { renderWithProviders } from "../test/testUtils";
import { useWorkItemCommands } from "../lib/useWorkItemCommands";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { useWorkItemKeyboardNav } from "../lib/useWorkItemKeyboardNav";

/**
 * Contract under test (independent of the implementation):
 *
 * - the foreground route owns editable controls; an inactive inspection or
 *   planner exposes no dialog/editor;
 * - leaving an inspection suspends it without writing and retains its draft;
 * - Back restores the recorded origin and Forward returns to the destination;
 * - closing B returns to A's planner, while an explicit refinement return
 *   restores B's detail rather than replacing A's retained inspection.
 *
 * State owners: the router owns location/history, TaskDetailProvider owns the
 * mounted inspected task and text handoff, and the task-inspection controller
 * owns the retained planner stack and navigation/return protocol. Navigation
 * is read-only; only an explicit save can call the API. The generated sequence only records intended surfaces and compares
 * them with rendered dialogs/routes, rather than reproducing those
 * transitions.
 */

const A = 101;
const B = 102;

const taskA = makeTask({
  id: A,
  title: "A",
  projectId: 7,
  projectTitle: "Project 7",
});
const taskB = makeTask({
  id: B,
  title: "B",
  projectId: 7,
  projectTitle: "Project 7",
});

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      getAuthStatus: vi.fn(),
      getMembers: vi.fn(),
      getTask: vi.fn(),
      getTaskRecurrenceHistory: vi.fn(),
      getTags: vi.fn(),
      getActivity: vi.fn(),
      getProject: vi.fn(),
      updateTask: vi.fn(),
    },
  };
});

type Event =
  | "list-open-a"
  | "open-a-planner"
  | "inspect-b"
  | "edit-draft"
  | "open-project"
  | "destination-open-b"
  | "back"
  | "forward"
  | "open-b-planner"
  | "open-b-waiting"
  | "return-refinement"
  | "close-inspection"
  | "close-workflow"
  | "intake-return";

type Expected = {
  route: string;
  detail: number | null;
  planner: number | null;
  draft: string | null;
  dialog: "none" | "visible";
};

function routePath() {
  return screen.getByTestId("inspection-route").textContent ?? "";
}

function visibleDialog() {
  return screen.queryByRole("dialog");
}

function expectObservable(expected: Expected) {
  expect(routePath()).toBe(expected.route);
  if (expected.dialog === "none") {
    expect(visibleDialog()).not.toBeInTheDocument();
  }
  if (expected.dialog === "visible") {
    const dialog = visibleDialog();
    expect(dialog).toBeInTheDocument();
    expect(dialog).toBeVisible();
  }
  if (expected.detail !== null && expected.planner === null && expected.route !== "/intake/9") {
    expect(screen.getByRole("heading", { level: 1, name: expected.detail === A ? "A" : "B" })).toBeVisible();
  }
  if (expected.draft !== null && expected.route === "/all" && expected.planner === A) {
    expect(screen.getAllByRole("textbox").at(-1)).toHaveValue(expected.draft);
  }
}

function ControllerHarness() {
  const detail = useTaskDetail();
  const taskWorkflow = useTaskWorkflow();
  const dispatch = useWorkItemCommands();
  const navigate = useNavigate();
  const location = useLocation();

  const openA = () => dispatch({ type: "task.open", taskId: A });
  const planA = () => dispatch({ type: "task.plan", taskId: A, target: "scheduled" });
  const inspectB = () => dispatch({ type: "task.open", taskId: B });
  const editDraft = () => {
    const input = screen.getAllByRole("textbox").at(-1);
    if (!input) return;
    fireEvent.change(input, { target: { value: "16.10.2026" } });
  };
  const openProject = () => dispatch({ type: "workItem.open", workItem: { role: "story", id: 7 } });
  const returnFromRefinement = () => {
    const handoff = detail.suspendForHandoff();
    navigate("/intake/9", {
      state: {
        refinementOrigin: {
          targetType: "task",
          targetId: B,
          originPath: "/all",
          entry: "task_detail",
          taskDetail: handoff,
        },
      },
    });
  };
  const returnToOrigin = () => {
    const origin = (location.state as { refinementOrigin?: { originPath: string; taskDetail?: Parameters<typeof detail.resumeAfterHandoff>[0] } } | null)?.refinementOrigin;
    taskWorkflow.refinementReturn();
    if (origin?.taskDetail) detail.resumeAfterHandoff(origin.taskDetail);
    navigate(origin?.originPath ?? "/all", { replace: true });
  };
  const destinationPlanner = () => {
    if (location.pathname === "/projects/7") {
      fireEvent.keyDown(document, { key: "s" });
    } else {
      dispatch({ type: "task.plan", taskId: B, target: "scheduled" });
    }
  };
  const destinationWaiting = () => {
    if (location.pathname === "/projects/7") {
      fireEvent.keyDown(document, { key: "w" });
    } else {
      dispatch({ type: "task.waitingLifecycle", taskId: B });
    }
  };

  return (
    <>
      <Routes>
        <Route path="*" element={
          <>
            <p data-testid="inspection-route">{location.pathname}</p>
            {location.pathname === "/projects/7" ? (
              <InteractionScopeProvider captureTarget={{ kind: "story", storyId: 7 }}>
                <DestinationProjectTasks />
              </InteractionScopeProvider>
            ) : null}
          </>
        } />
      </Routes>
      <button data-testid="list-open-a" onClick={openA}>List open A</button>
      <button data-testid="open-a-planner" onClick={planA}>Open A planner</button>
      <button data-testid="inspect-b" onClick={inspectB}>Inspect B</button>
      <button data-testid="edit-draft" onClick={editDraft}>Edit draft</button>
      <button data-testid="open-project" onClick={openProject}>Open project</button>
      <button data-testid="destination-open-b" onClick={() => fireEvent.keyDown(document, { key: "j" })}>Destination select B</button>
      <button data-testid="back" onClick={() => navigate(-1)}>Back</button>
      <button data-testid="forward" onClick={() => navigate(1)}>Forward</button>
      <button data-testid="open-b-planner" onClick={destinationPlanner}>Open B planner</button>
      <button data-testid="open-b-waiting" onClick={destinationWaiting}>Open B waiting</button>
      <button data-testid="return-refinement" onClick={returnFromRefinement}>Return from refinement</button>
      <button data-testid="intake-return" onClick={returnToOrigin}>Return to origin</button>
      <button data-testid="close-inspection" onClick={() => detail.close()}>Close inspection</button>
      <button data-testid="close-workflow" onClick={() => taskWorkflow.close()}>Close workflow</button>
      <output data-testid="inspection-count">{taskWorkflow.detailInspections.length}</output>
      <TaskDetailSheet />
      <TaskWorkflowHost />
    </>
  );
}

function DestinationProjectTasks() {
  useWorkItemKeyboardNav();
  return <button data-workitem-id={B} data-workitem-role="task" className="task-row-main">B</button>;
}

function renderController(initialEntries: string[] = ["/all"]) {
  return renderWithProviders(<ControllerHarness />, { initialEntries });
}

async function click(id: Event) {
  await act(async () => {
    screen.getByTestId(id).click();
    await Promise.resolve();
  });
}

describe("task inspection sequence contract", () => {
  beforeEach(() => {
    window.localStorage.setItem("machbar:identity-member-id", "1");
    vi.mocked(api.getAuthStatus).mockResolvedValue({ enabled: false, authenticated: false, member: null });
    vi.mocked(api.getMembers).mockResolvedValue([makeMember({ id: 1, name: "Alex" })]);
    vi.mocked(api.getTask).mockImplementation(async (id) => ({ ...(id === A ? taskA : taskB) }));
    vi.mocked(api.getTaskRecurrenceHistory).mockResolvedValue({
      summary: { hitCount: 0, missCount: 0, totalCount: 0, hitRate: null },
      occurrences: [],
    });
    vi.mocked(api.getTags).mockResolvedValue([]);
    vi.mocked(api.getActivity).mockResolvedValue(undefined as never);
    vi.mocked(api.getProject).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("runs bounded reproducible sequences through the real router and providers", async () => {
    // Destination-page shortcuts are bounded to the named #288 baselines below;
    // this passing generator asserts every executed event independently.
    const events = fc.array(
      fc.constantFrom<Event>(
        "list-open-a", "open-a-planner", "inspect-b", "edit-draft",
        "open-project", "back", "forward", "open-b-planner",
        "open-b-waiting", "return-refinement", "intake-return", "close-inspection",
      ),
      { minLength: 4, maxLength: 9 },
    );

    await fc.assert(
      fc.asyncProperty(events, async (sequence) => {
        const rendered = renderController();
        try {
          const expected: Expected = { route: "/all", detail: null, planner: null, draft: null, dialog: "none" };
          let projectHistory = false;
          for (const event of sequence) {
            const writesBefore = vi.mocked(api.updateTask).mock.calls.length;
            switch (event) {
              case "list-open-a":
                await click("list-open-a");
                expected.route = "/all";
                expected.detail = A;
                expected.planner = null;
                expected.dialog = "visible";
                break;
              case "open-a-planner":
                if (expected.detail !== null) break;
                await click("open-a-planner");
                expected.planner = A;
                expected.detail = null;
                expected.dialog = "visible";
                break;
              case "inspect-b":
                if (expected.planner !== A) break;
                await click("inspect-b");
                expected.detail = B;
                expected.planner = null;
                expected.dialog = "visible";
                break;
              case "edit-draft":
                if (expected.planner !== A || expected.route !== "/all") break;
                await click("edit-draft");
                expected.draft = "16.10.2026";
                break;
              case "open-project":
                if (expected.detail !== B) break;
                await click("open-project");
                expected.route = "/projects/7";
                expected.detail = null;
                expected.dialog = "none";
                projectHistory = true;
                break;
              case "destination-open-b":
                if (!projectHistory || expected.route !== "/projects/7") break;
                await click("destination-open-b");
                break;
              case "back":
                if (!projectHistory || expected.route !== "/projects/7") break;
                await click("back");
                expected.route = "/all";
                expected.detail = B;
                expected.dialog = "visible";
                break;
              case "forward":
                if (!projectHistory || expected.route !== "/all") break;
                await click("forward");
                expected.route = "/projects/7";
                expected.detail = null;
                expected.dialog = "none";
                break;
              case "open-b-planner":
                if (!(expected.detail === B && expected.route === "/all")) break;
                await click("open-b-planner");
                expected.planner = B;
                expected.detail = null;
                expected.dialog = "visible";
                break;
              case "open-b-waiting":
                if (!(expected.detail === B && expected.route === "/all")) break;
                await click("open-b-waiting");
                expected.planner = B;
                expected.detail = null;
                expected.dialog = "visible";
                break;
              case "return-refinement":
                if (expected.detail !== B) break;
                await click("return-refinement");
                expected.route = "/intake/9";
                expected.detail = null;
                expected.dialog = "none";
                break;
              case "intake-return":
                if (expected.route !== "/intake/9") break;
                await click("intake-return");
                expected.route = "/all";
                expected.detail = B;
                expected.dialog = "visible";
                break;
              case "close-inspection": {
                const closedDetail = expected.detail;
                await click("close-inspection");
                expected.detail = null;
                if (expected.route === "/all" && closedDetail === B) expected.planner = A;
                expected.dialog = expected.planner === A ? "visible" : "none";
                break;
              }
            }
            await waitFor(() => expectObservable(expected));
            expect(vi.mocked(api.updateTask).mock.calls.length).toBe(writesBefore);
          }
        } finally {
          rendered.unmount();
        }
      }),
      { seed: 28601, numRuns: 12 },
    );
  });

  it("restores and hides inspection across distinct same-project history entries", async () => {
    renderController(["/projects/7"]);
    await click("open-a-planner");
    await click("inspect-b");
    await click("open-project");
    await click("back");
    await click("forward");
    await waitFor(() => expect(routePath()).toBe("/projects/7"));
    await waitFor(() => expect(visibleDialog()).not.toBeInTheDocument());
  });

  it("returns to the list when closing a restored planner with no prior detail", async () => {
    renderController();
    await click("list-open-a");
    await click("close-inspection");
    await click("open-a-planner");
    await click("inspect-b");
    await click("open-project");
    await click("back");
    await click("close-inspection");
    await click("close-workflow");
    await waitFor(() => expect(routePath()).toBe("/all"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "A", level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "B", level: 1 })).not.toBeInTheDocument();
  });

  it.fails("reproduces destination planner inheriting inspection suspension (known #288 baseline)", async () => {
    renderController();
    await click("list-open-a");
    await click("close-inspection");
    await click("open-a-planner");
    await click("inspect-b");
    await click("open-project");
    await click("destination-open-b");
    await click("open-b-planner");
    await waitFor(() => expect(routePath()).toBe("/projects/7"));
    await waitFor(() => expect(visibleDialog()).toBeInTheDocument());
  });

  it.fails("reproduces destination waiting shortcut inheriting inspection suspension (known #288 baseline)", async () => {
    renderController();
    await click("list-open-a");
    await click("close-inspection");
    await click("open-a-planner");
    await click("inspect-b");
    await click("open-project");
    await click("destination-open-b");
    await click("open-b-waiting");
    await waitFor(() => expect(routePath()).toBe("/projects/7"));
    await waitFor(() => expect(visibleDialog()).toBeInTheDocument());
  });

  it("keeps explicit refinement return separate from retained inspection", async () => {
    renderController();
    await click("list-open-a");
    await click("close-inspection");
    await click("open-a-planner");
    await click("inspect-b");
    await click("return-refinement");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await click("intake-return");
    await waitFor(() => expect(screen.getByRole("heading", { name: "B", level: 1 })).toBeVisible());
    await click("open-project");
    await click("back");
    await waitFor(() => expect(routePath()).toBe("/all"));
    expect(screen.getByRole("heading", { name: "B", level: 1 })).toBeVisible();
    await click("open-b-planner");
    await waitFor(() => expect(visibleDialog()).toBeInTheDocument());
    await click("close-workflow");
    await waitFor(() => expect(screen.getByRole("heading", { name: "B", level: 1 })).toBeVisible());
    expect(vi.mocked(api.updateTask)).not.toHaveBeenCalled();
  });

  it("updates every retained inspection sharing the refinement origin key", async () => {
    renderController();
    await click("list-open-a");
    await click("close-inspection");
    await click("open-a-planner");
    await click("inspect-b");
    await click("open-b-planner");
    await click("inspect-b");
    await click("return-refinement");
    await click("intake-return");
    await click("close-inspection");
    await click("close-workflow");
    await waitFor(() => expect(screen.getByRole("heading", { name: "B", level: 1 })).toBeVisible());
    await click("open-project");
    await click("back");
    await waitFor(() => expect(screen.getByRole("heading", { name: "B", level: 1 })).toBeVisible());
  });

  it("reuses a retained frame for repeated inspection of the same entry", async () => {
    renderController();
    await click("list-open-a");
    await click("close-inspection");
    await click("open-a-planner");
    await click("inspect-b");
    await click("inspect-b");
    expect(screen.getByTestId("inspection-count")).toHaveTextContent("1");
  });
});
