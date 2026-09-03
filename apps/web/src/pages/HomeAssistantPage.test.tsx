import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/testUtils";
import { HomeAssistantPage } from "./HomeAssistantPage";

const { getHomeAssistantStatus } = vi.hoisted(() => ({
  getHomeAssistantStatus: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    getAuthStatus: vi.fn().mockResolvedValue({
      enabled: false,
      authenticated: false,
      member: null,
    }),
    getMembers: vi.fn().mockResolvedValue([
      { id: 1, name: "Mira", color: "#123456", pictureUrl: null },
    ]),
    getHomeAssistantStatus,
  },
}));

describe("HomeAssistantPage", () => {
  beforeEach(() => {
    getHomeAssistantStatus.mockResolvedValue({
      connected: true,
      instanceId: "ha-1",
      protocolVersion: 1,
      connectedAt: "2026-09-03T10:00:00.000Z",
      lastUpdateAt: "2026-09-03T12:00:00.000Z",
      stale: false,
      contexts: [],
      people: [
        {
          externalId: "person.mira",
          name: "Mira",
          state: "known",
          contexts: [
            {
              id: 1,
              source: "home_assistant",
              externalId: "zone.seligenstadt",
              name: "Seligenstadt",
              active: true,
              updatedAt: "2026-09-03T12:00:00.000Z",
            },
          ],
          mappedMemberId: 1,
          observedAt: "2026-09-03T12:00:00.000Z",
        },
        {
          externalId: "person.unknown",
          name: "Alex",
          state: "unknown",
          contexts: [],
          mappedMemberId: null,
          observedAt: "2026-09-03T12:00:00.000Z",
        },
      ],
    });
  });

  it("shows where each Home Assistant person was last observed", async () => {
    renderWithProviders(<HomeAssistantPage />);

    expect(await screen.findByText("Aktueller Ort: Seligenstadt", { exact: false }))
      .toBeInTheDocument();
    expect(screen.getByText("Ort unbekannt", { exact: false }))
      .toBeInTheDocument();
  });
});
