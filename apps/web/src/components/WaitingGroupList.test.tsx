import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { WaitingGroupList } from "./WaitingGroupList";
import { api } from "../lib/api";
import { makeMember, makeTask, makeWaitingGroup } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    updateTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("WaitingGroupList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
    mockedApi.updateTask.mockResolvedValue(makeTask());
  });

  it("gruppiert Aufgaben nach Wartet-auf und markiert sie wieder machbar", async () => {
    const task = makeTask({ id: 7, title: "Rückmeldung abwarten", status: "waiting" });
    const group = makeWaitingGroup({ waitingFor: "Steuerberater", tasks: [task] });
    renderWithProviders(<WaitingGroupList groups={[group]} />);

    expect(await screen.findByText(/Steuerberater/)).toBeInTheDocument();
    expect(screen.getByText("Rückmeldung abwarten")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Wieder machbar" }));

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(7, { status: "actionable" }));
  });

  it("zeigt einen leeren Zustand ohne Gruppen", () => {
    renderWithProviders(<WaitingGroupList groups={[]} />);
    expect(screen.getByText("Nichts wartet gerade.")).toBeInTheDocument();
  });
});
