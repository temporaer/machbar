import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
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
    expect(screen.getByRole("heading", { name: "Ort" })).toBeInTheDocument();
    expect(screen.getByText("Freigabe abwarten")).toBeInTheDocument();
    expect(screen.getByText("Im Garten arbeiten")).toBeInTheDocument();
  });

  it("offers follow-up only for an external wait", async () => {
    const { container } = renderWithProviders(
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
    await screen.findByText("Rückruf");
    // Waiting/follow-up lives in the status/lifecycle rail (swipe right),
    // not the fixed Später/Struktur/Mehr action rail.
    const content = container.querySelector(".task-row-content") as HTMLElement;
    fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(content, { clientX: 150, pointerId: 1 });
    fireEvent.pointerUp(content, { clientX: 150, pointerId: 1 });
    expect(screen.getByRole("button", { name: "Nachhaken" })).toBeInTheDocument();
  });
});
