import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { WaitingGroupList } from "./WaitingGroupList";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
  },
}));

describe("WaitingGroupList", () => {
  beforeEach(() => {
    vi.mocked(api.getMembers).mockResolvedValue([
      makeMember({ id: 1, name: "Mira" }),
    ]);
  });

  it("separates external and physical-context reasons", async () => {
    renderWithProviders(
      <WaitingGroupList
        entries={[
          {
            task: makeTask({
              id: 1,
              title: "Freigabe abwarten",
              externalWait: { waitingFor: "Vermieter", revisitDate: null },
            }),
            reasons: [
              {
                type: "external",
                waitingFor: "Vermieter",
                revisitDate: null,
              },
            ],
          },
          {
            task: makeTask({ id: 2, title: "Im Garten arbeiten" }),
            reasons: [{ type: "context", contexts: [] }],
          },
        ]}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Extern" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Kontext" })).toBeInTheDocument();
    expect(screen.getByText("Freigabe abwarten")).toBeInTheDocument();
    expect(screen.getByText("Im Garten arbeiten")).toBeInTheDocument();
  });

  it("offers follow-up only for an external wait", async () => {
    renderWithProviders(
      <WaitingGroupList
        entries={[
          {
            task: makeTask({
              id: 1,
              title: "Rückruf",
              externalWait: { waitingFor: "Vermieter", revisitDate: null },
            }),
            reasons: [
              {
                type: "external",
                waitingFor: "Vermieter",
                revisitDate: null,
              },
            ],
          },
        ]}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Weitere Aktionen" }),
    );
    expect(screen.getByRole("button", { name: "Nachhaken" })).toBeInTheDocument();
  });
});
