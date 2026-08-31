import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { WaitingGroupList } from "./WaitingGroupList";
import { api } from "../lib/api";
import { makeMember, makeTag, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTask: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
    setExternalWait: vi.fn(),
    resolveExternalWait: vi.fn(),
    reorderTask: vi.fn(),
    indentTask: vi.fn(),
    outdentTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("WaitingGroupList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
  });

  it("renders every blocked task once with external and dependency reasons", async () => {
    const task = makeTask({
      id: 101,
      title: "Freigabe abwarten",
      blocked: true,
      executable: false,
      externalWait: { waitingFor: "Vermieter" },
      dependencies: [{
        id: 3,
        taskId: 101,
        dependsOnTaskId: 99,
        title: "Angebot prüfen",
        resolved: false,
      }],
      nextBlockerAttentionDate: "2026-09-05",
    });
    renderWithProviders(<WaitingGroupList tasks={[task, task]} />);

    expect(await screen.findAllByText("Freigabe abwarten")).toHaveLength(1);
    expect(screen.getByText("Wartet auf: Vermieter")).toBeInTheDocument();
    expect(screen.getByText("Blockiert durch: Angebot prüfen")).toBeInTheDocument();
  });

  it("retains tag grouping and opens follow-up only for external waits", async () => {
    const phone = makeTag({ id: 2, name: "Telefon", kind: "context" });
    const task = makeTask({
      id: 102,
      title: "Rückruf",
      blocked: true,
      executable: false,
      externalWait: { waitingFor: "Vermieter" },
      effectiveTags: [phone],
    });
    renderWithProviders(<WaitingGroupList tasks={[task]} groupBy="context" />);
    expect(await screen.findByRole("heading", { name: "Telefon" })).toBeInTheDocument();
    expect(screen.getByText("Wartet auf: Vermieter")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(screen.getByRole("button", { name: "Nachhaken" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
