import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Member, ReflectionBriefing, ReflectionBriefingScope } from "@machbar/shared";
import { renderWithProviders } from "../test/testUtils";
import { api } from "../lib/api";
import { SELECTED_MEMBER_STORAGE_KEY } from "../lib/identityStorage";
import { ReflectionStartPage } from "./ReflectionStartPage";

vi.mock("../lib/api", () => ({
  api: {
    getAuthStatus: vi.fn().mockResolvedValue({ enabled: false, authenticated: false, member: null }),
    getMembers: vi.fn().mockResolvedValue([{ id: 7, name: "Mira", color: "#123456", pictureUrl: null }]),
    getReflectionBriefing: vi.fn(),
  },
}));

const mira: Member = { id: 7, name: "Mira", color: "#123456", pictureUrl: null };

function makeBriefing(scope: ReflectionBriefingScope, days: 30 | 90 | 180): ReflectionBriefing {
  return {
    generatedAt: "2026-10-10T12:00:00Z",
    subject: mira,
    scope,
    timezone: "Europe/Berlin",
    window: { days, startDate: "2026-09-11", endDate: "2026-10-10" },
    current: { activeProjects: [], executableNextActions: [], waitingItems: [], backlog: [], areaCommitments: [] },
    history: {
      finiteCompletions: [], bulkCompletionGroups: [], recurringWork: [], inactiveWork: [], postponements: [],
      progress: { lastOutcomeProgressAt: null, lastWorkEnablingProgressAt: null, lastActivityAt: null, projectsWithRecordedChildOutcomes: [], checkedAcceptanceCriteria: [], verifiedUnblocking: [] },
      activityCounts: { administrative: 0, finiteOutcomes: 0, milestones: 0, recurringOccurrences: 0, explicitPostponements: 0, unresolvedActiveWork: 0 },
      evidence: { incomplete: true, notes: ["only visible data"] },
    },
    markdown: `# Report for ${scope}`,
  };
}

describe("ReflectionStartPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(SELECTED_MEMBER_STORAGE_KEY, "7");
    vi.mocked(api.getReflectionBriefing).mockImplementation(async (_memberId, days, scope) => makeBriefing(scope, days));
  });

  it("previews the complete package and explicitly gates private work before sharing", async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    renderWithProviders(<ReflectionStartPage />);

    const preview = await screen.findByRole("textbox", { name: "Vollständiger Inhalt zum Teilen" });
    expect(api.getReflectionBriefing).toHaveBeenCalledWith(7, 90, "household");
    expect((preview as HTMLTextAreaElement).value).toContain("Sachlicher Machbar-Rückblick");
    expect((preview as HTMLTextAreaElement).value).toContain("Faktenbasis");
    expect((preview as HTMLTextAreaElement).value).toContain("# Report for household");

    await user.click(screen.getByRole("button", { name: "Haushalt + meine Arbeit" }));
    await waitFor(() => expect(api.getReflectionBriefing).toHaveBeenLastCalledWith(7, 90, "all"));
    await screen.findByRole("checkbox", { name: /privaten Arbeitsdaten enthalten/ });
    const shareButton = screen.getByRole("button", { name: "Teilen" });
    expect(shareButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Kopieren" })).toBeDisabled();
    expect(screen.getByText(/private Arbeitsdaten/)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /privaten Arbeitsdaten enthalten/ }));
    expect(shareButton).toBeEnabled();
    const exactPreview = (screen.getByRole("textbox", { name: "Vollständiger Inhalt zum Teilen" }) as HTMLTextAreaElement).value;
    await user.click(shareButton);
    await waitFor(() => expect(share).toHaveBeenCalledWith({ title: "Machbar-Reflexion", text: exactPreview }));

    await user.click(screen.getByRole("button", { name: "Meine Arbeit" }));
    const privateConsent = await screen.findByRole("checkbox", { name: /privaten Arbeitsdaten enthalten/ });
    expect(privateConsent).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Teilen" })).toBeDisabled();
  });

  it("refreshes the deterministic briefing when the period changes and copies only the preview", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderWithProviders(<ReflectionStartPage />);

    await screen.findByRole("textbox", { name: "Vollständiger Inhalt zum Teilen" });
    await user.click(screen.getByRole("button", { name: "30 Tage" }));
    await waitFor(() => expect(api.getReflectionBriefing).toHaveBeenLastCalledWith(7, 30, "household"));
    await screen.findByRole("textbox", { name: "Vollständiger Inhalt zum Teilen" });
    const exactPreview = (screen.getByRole("textbox", { name: "Vollständiger Inhalt zum Teilen" }) as HTMLTextAreaElement).value;
    await user.click(screen.getByRole("button", { name: "Kopieren" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(exactPreview));
  });

  it("requires fresh consent after switching away and back by scope or period", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReflectionStartPage />);

    await screen.findByRole("textbox", { name: "Vollständiger Inhalt zum Teilen" });
    await user.click(screen.getByRole("button", { name: "Haushalt + meine Arbeit" }));
    let consent = await screen.findByRole("checkbox", { name: /privaten Arbeitsdaten enthalten/ });
    await user.click(consent);
    expect(screen.getByRole("button", { name: "Kopieren" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Haushalt" }));
    await user.click(screen.getByRole("button", { name: "Haushalt + meine Arbeit" }));
    consent = await screen.findByRole("checkbox", { name: /privaten Arbeitsdaten enthalten/ });
    expect(consent).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Kopieren" })).toBeDisabled();

    await user.click(consent);
    await user.click(screen.getByRole("button", { name: "30 Tage" }));
    await user.click(screen.getByRole("button", { name: "90 Tage" }));
    consent = await screen.findByRole("checkbox", { name: /privaten Arbeitsdaten enthalten/ });
    expect(consent).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Kopieren" })).toBeDisabled();
  });

  it("requires consent again when retrying produces a refreshed private briefing", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getReflectionBriefing)
      .mockImplementationOnce(async (_memberId, days, scope) => makeBriefing(scope, days))
      .mockImplementationOnce(async (_memberId, days, scope) => makeBriefing(scope, days))
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockImplementationOnce(async (_memberId, days, scope) => makeBriefing(scope, days));
    renderWithProviders(<ReflectionStartPage />);

    await screen.findByRole("textbox", { name: "Vollständiger Inhalt zum Teilen" });
    await user.click(screen.getByRole("button", { name: "Haushalt + meine Arbeit" }));
    const consent = await screen.findByRole("checkbox", { name: /privaten Arbeitsdaten enthalten/ });
    await user.click(consent);
    expect(screen.getByRole("button", { name: "Kopieren" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "30 Tage" }));
    const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
    await user.click(retry);
    const refreshedConsent = await screen.findByRole("checkbox", { name: /privaten Arbeitsdaten enthalten/ });
    expect(refreshedConsent).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Kopieren" })).toBeDisabled();
  });
});
