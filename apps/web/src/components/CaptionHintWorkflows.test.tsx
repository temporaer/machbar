import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import {
  makeMember,
  makePhysicalContext,
  makeTag,
  makeTask,
} from "../test/fixtures";
import { renderWithProviders } from "../test/testUtils";
import { TaskContextsSheet } from "./TaskContextsSheet";
import { TaskOwnerSheet } from "./TaskOwnerSheet";
import { TaskPlanSheet } from "./TaskPlanSheet";
import { TaskTagsSheet } from "./TaskTagsSheet";
import { TaskWaitSheet } from "./TaskWaitSheet";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getHomeAssistantStatus: vi.fn(),
    updateTask: vi.fn(),
    setExternalWait: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);
const createdAt = new Date(2026, 8, 14, 12).toISOString();

describe("caption hints in focused task workflows", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([]);
    mockedApi.getTags.mockResolvedValue([]);
    mockedApi.getHomeAssistantStatus.mockResolvedValue(null as never);
  });

  it("commits accepted schedule and deadline hints with one cleaned-title patch", async () => {
    const task = makeTask({
      id: 41,
      revision: 3,
      title: "Fenster morgen putzen, bis Freitag",
      createdAt,
    });
    mockedApi.updateTask.mockResolvedValue({ ...task, revision: 4 } as never);
    renderWithProviders(<TaskPlanSheet task={task} onClose={vi.fn()} />);

    await userEvent.click(
      screen.getByRole("button", { name: /^Planen: 15\./ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "+ Deadline hinzufügen" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Deadline: 18\./ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(41, {
        revisitAt: null,
        scheduledDate: "2026-09-15",
        dueDate: "2026-09-18",
        title: "Fenster putzen",
        expectedRevision: 3,
      }),
    );
  });

  it("does not mutate anything when a staged planning hint is cancelled", async () => {
    const task = makeTask({
      id: 42,
      title: "Fenster morgen putzen",
      createdAt,
    });
    renderWithProviders(<TaskPlanSheet task={task} onClose={vi.fn()} />);

    await userEvent.click(
      screen.getByRole("button", { name: /^Planen: 15\./ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));

    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("passes an accepted member and cleaned title through the owner callback", async () => {
    const anna = makeMember({ id: 7, name: "Anna" });
    const onSelect = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <TaskOwnerSheet
        title="Zuweisen"
        taskTitle="für Anna anrufen"
        createdAt={createdAt}
        members={[anna]}
        ownerMemberId={null}
        ownerInheritanceMode="none"
        inheritedOwnerId={null}
        inheritanceSource={null}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );

    await userEvent.click(screen.getAllByRole("button", { name: "Anna" })[0]!);

    expect(onSelect).toHaveBeenCalledWith(
      { ownerMemberId: 7, ownerInheritanceMode: "explicit" },
      "anrufen",
    );
  });

  it("adds an existing tag and cleans only its source phrase", async () => {
    const tag = makeTag({ id: 8, name: "Heizung" });
    const task = makeTask({
      id: 43,
      revision: 2,
      title: "#Heizung prüfen",
      createdAt,
    });
    mockedApi.getTags.mockResolvedValue([tag]);
    mockedApi.updateTask.mockResolvedValue({ ...task, revision: 3 } as never);
    renderWithProviders(<TaskTagsSheet task={task} onClose={vi.fn()} />);

    await userEvent.click(
      (await screen.findAllByRole("button", { name: "Heizung" }))[0]!,
    );

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(43, {
        tagIds: [8],
        title: "prüfen",
        expectedRevision: 2,
      }),
    );
  });

  it("adds a known active context with canonical explicit inheritance semantics", async () => {
    const context = makePhysicalContext({ id: 9, name: "Baumarkt" });
    const task = makeTask({
      id: 44,
      revision: 5,
      title: "Baumarkt Schrauben holen",
      createdAt,
      contextInheritanceMode: "inherit",
    });
    mockedApi.getHomeAssistantStatus.mockResolvedValue({
      connected: true,
      contexts: [context],
    } as never);
    mockedApi.updateTask.mockResolvedValue({ ...task, revision: 6 } as never);
    renderWithProviders(<TaskContextsSheet task={task} onClose={vi.fn()} />);

    await userEvent.click(
      (await screen.findAllByRole("button", { name: "Baumarkt" }))[0]!,
    );

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(44, {
        contextInheritanceMode: "explicit",
        contextIds: [9],
        title: "Schrauben holen",
        expectedRevision: 5,
      }),
    );
  });

  it("prefills waiting-for and revisit hints while preserving the title", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T10:00:00+02:00"));
    const peter = makeMember({ id: 10, name: "Peter" });
    const task = makeTask({
      id: 45,
      revision: 7,
      title: "auf Peter warten, Montag nachhaken",
      createdAt,
    });
    mockedApi.setExternalWait.mockResolvedValue({
      ...task,
      revision: 8,
      externalWait: { waitingFor: "Peter", revisitDate: "2026-09-21" },
    } as never);
    renderWithProviders(
      <TaskWaitSheet task={task} members={[peter]} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Peter" }));
    fireEvent.click(
      screen.getByRole("button", { name: /^Wiedervorlage: 21\./ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Warten" }));
    vi.useRealTimers();

    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(45, {
        waitingFor: "Peter",
        revisitAt: "2026-09-21T04:00:00Z",
        expectedRevision: 7,
      }),
    );
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("preserves an existing timed revisit and work plan when starting a wait without changing its date", async () => {
    const task = makeTask({
      id: 46,
      revision: 2,
      revisitAt: "2026-09-18T16:00:00.000Z",
      scheduledDate: "2026-09-25",
    });
    mockedApi.setExternalWait.mockResolvedValue({
      ...task,
      revision: 3,
      externalWait: { waitingFor: "Lieferant", revisitDate: null },
    } as never);
    renderWithProviders(
      <TaskWaitSheet task={task} members={[]} onClose={vi.fn()} />,
    );

    await userEvent.type(
      screen.getByLabelText("Worauf wartest du?"),
      "Lieferant",
    );
    await userEvent.click(screen.getByRole("button", { name: "Warten" }));

    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(46, {
        waitingFor: "Lieferant",
        expectedRevision: 2,
      }),
    );
  });

  it("replaces the revisit only when the user chooses a new follow-up date", async () => {
    const task = makeTask({
      id: 47,
      revision: 5,
      revisitAt: "2026-09-18T16:00:00.000Z",
      scheduledDate: "2026-09-25",
    });
    mockedApi.setExternalWait.mockResolvedValue({
      ...task,
      revision: 6,
      externalWait: { waitingFor: "Lieferant", revisitDate: null },
    } as never);
    renderWithProviders(
      <TaskWaitSheet task={task} members={[]} onClose={vi.fn()} />,
    );

    await userEvent.type(
      screen.getByLabelText("Worauf wartest du?"),
      "Lieferant",
    );
    await userEvent.click(screen.getByRole("button", { name: "Morgen" }));
    await userEvent.click(screen.getByRole("button", { name: "Warten" }));

    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(
        47,
        expect.objectContaining({
          waitingFor: "Lieferant",
          revisitAt: expect.any(String),
          expectedRevision: 5,
        }),
      ),
    );
    expect(mockedApi.setExternalWait.mock.calls[0]?.[1]).not.toHaveProperty(
      "scheduledDate",
    );
  });

  it("clears a revisit only after explicitly choosing no date", async () => {
    const task = makeTask({
      id: 48,
      revision: 3,
      revisitAt: "2026-09-18T16:00:00.000Z",
      scheduledDate: "2026-09-25",
    });
    mockedApi.setExternalWait.mockResolvedValue({
      ...task,
      revision: 4,
      revisitAt: null,
      externalWait: { waitingFor: "Lieferant", revisitDate: null },
    } as never);
    renderWithProviders(
      <TaskWaitSheet task={task} members={[]} onClose={vi.fn()} />,
    );

    await userEvent.type(
      screen.getByLabelText("Worauf wartest du?"),
      "Lieferant",
    );
    await userEvent.click(screen.getByRole("button", { name: "Kein Datum" }));
    await userEvent.click(screen.getByRole("button", { name: "Warten" }));

    await waitFor(() =>
      expect(mockedApi.setExternalWait).toHaveBeenCalledWith(48, {
        waitingFor: "Lieferant",
        revisitAt: null,
        expectedRevision: 3,
      }),
    );
  });
});
