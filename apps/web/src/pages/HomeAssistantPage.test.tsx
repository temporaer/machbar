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
  const intake = (aiState: "ok" | "not_configured" = "ok", calendarState: "ok" | "not_writable" = "ok") => ({
    aiTask: { entityId: aiState === "ok" ? "ai_task.school" : null, state: aiState, supportsAttachments: true },
    calendar: { entityId: "calendar.family", state: calendarState },
  });
  beforeEach(() => {
    getHomeAssistantStatus.mockResolvedValue({
      connected: true,
      instanceId: "ha-1",
      protocolVersion: 3,
      connectedAt: "2026-09-03T10:00:00.000Z",
      lastUpdateAt: "2026-09-03T12:00:00.000Z",
      stale: false,
      supportedProtocolVersion: 3,
      protocolOutdated: false,
      lastRequestPollAt: null,
      workerOnline: false,
      intake: intake(),
      intakeReady: true,
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

  it("shows AI and calendar readiness states", async () => {
    getHomeAssistantStatus.mockResolvedValueOnce({
      connected: true, instanceId: "ha", protocolVersion: 3, connectedAt: null,
      lastUpdateAt: null, stale: false, supportedProtocolVersion: 3,
      protocolOutdated: false, lastRequestPollAt: null, workerOnline: true,
      intake: intake(), intakeReady: true, contexts: [], people: [],
    });
    const first = renderWithProviders(<HomeAssistantPage />);
    expect(await screen.findByText("Worker online")).toBeInTheDocument();
    expect(screen.getByText(/ai_task.school/)).toBeInTheDocument();
    expect(screen.getByText("Verarbeiten bereit")).toBeInTheDocument();
    expect(screen.getByText(/AI-Task verfügbar/, { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Anhänge: Ja – Fotos und Dateien können verarbeitet werden."))
      .toBeInTheDocument();
    expect(screen.getByText(/Kalender verfügbar und beschreibbar/, { exact: false }))
      .toBeInTheDocument();

    first.unmount();
    getHomeAssistantStatus.mockResolvedValueOnce({
      connected: true, instanceId: "ha", protocolVersion: 3, connectedAt: null,
      lastUpdateAt: null, stale: false, supportedProtocolVersion: 3,
      protocolOutdated: false, lastRequestPollAt: null, workerOnline: false,
      intake: intake("not_configured", "not_writable"), intakeReady: false,
      contexts: [], people: [],
    });
    renderWithProviders(<HomeAssistantPage />);
    expect(await screen.findByText("Worker offline")).toBeInTheDocument();
    expect(screen.getByText("Verarbeiten noch nicht bereit")).toBeInTheDocument();
    expect(screen.getByText(/Kein AI-Task-Entity gewählt\./)).toBeInTheDocument();
    expect(screen.getByText(/Der gewählte Kalender ist nicht beschreibbar\./, { exact: false }))
      .toBeInTheDocument();
    expect(screen.getByText("Anhänge: Ja – Fotos und Dateien können verarbeitet werden."))
      .toBeInTheDocument();

    getHomeAssistantStatus.mockResolvedValueOnce({
      connected: true, instanceId: "ha", protocolVersion: 1, connectedAt: null,
      lastUpdateAt: null, stale: false, supportedProtocolVersion: 3,
      protocolOutdated: true, lastRequestPollAt: null, workerOnline: false,
      intake: intake(), intakeReady: false, contexts: [], people: [],
    });
    first.unmount();
    renderWithProviders(<HomeAssistantPage />);
    expect(await screen.findByText("Integration in Home Assistant aktualisieren und neu starten")).toBeInTheDocument();
  });
});
