import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { WaitingPage } from "./WaitingPage";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";
import { makeMember, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getWaiting: vi.fn(),
  },
}));

describe("WaitingPage", () => {
  beforeEach(() => {
    vi.mocked(api.getMembers).mockResolvedValue([
      makeMember({ id: 1, name: "Mira" }),
    ]);
  });

  it("renders typed waiting entries", async () => {
    vi.mocked(api.getWaiting).mockResolvedValue([
      {
        task: makeTask({
          title: "Freigabe abwarten",
          externalWait: { waitingFor: "Freigabe", revisitDate: null },
        }),
        reasons: [
          { type: "external", waitingFor: "Freigabe", revisitDate: null },
        ],
      },
    ]);
    renderWithProviders(<WaitingPage />);
    expect(await screen.findByText("Freigabe abwarten")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Extern" })).toBeInTheDocument();
  });
});
