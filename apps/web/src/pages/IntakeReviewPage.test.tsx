import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders } from "../test/testUtils";
import { IntakeReviewPage } from "./IntakeReviewPage";
import { api } from "../lib/api";

const mockedApi = vi.mocked(api, true);

vi.mock("../lib/api", () => ({
  api: {
    getIntake: vi.fn(),
    updateIntakeDraft: vi.fn(),
    applyIntake: vi.fn(),
    retryIntake: vi.fn(),
    deleteIntake: vi.fn(),
    getAuthStatus: vi.fn().mockResolvedValue({ enabled: false, authenticated: false, member: null }),
    getMembers: vi.fn().mockResolvedValue([
      { id: 1, name: "Mira", color: "#123456", pictureUrl: null },
    ]),
  },
}));

const draft = {
  summary: "Schulfest",
  calendarEvents: [{
    key: "event",
    title: "Elternabend",
    description: null,
    location: null,
    allDay: false,
    startDate: null,
    endDate: null,
    startDateTime: "2026-10-08T19:00:00+02:00",
    endDateTime: "2026-10-08T20:00:00+02:00",
    relatedWorkKeys: ["parent", "child"],
    enabled: true,
    durationAssumed: true,
  }],
  workItems: [{
    key: "parent",
    kind: "action" as const,
    title: "Rückmeldezettel abgeben",
    notes: null,
    parentKey: null,
    dueDate: "2026-10-02",
    scheduledDate: null,
    notBeforeDate: null,
    notBeforeAt: null,
    reminderAt: null,
    needsClarification: false,
    relatedCalendarKeys: ["event"],
    enabled: true,
    ownerMemberId: 1,
  }, {
    key: "child",
    kind: "action" as const,
    title: "Formular mitbringen",
    notes: null,
    parentKey: "parent",
    dueDate: null,
    scheduledDate: null,
    notBeforeDate: null,
    notBeforeAt: null,
    reminderAt: null,
    needsClarification: false,
    relatedCalendarKeys: ["event"],
    enabled: true,
    ownerMemberId: null,
  }],
  warnings: [{ message: "No end time in source; 60 min assumed" }],
  retainSourceInPaperless: false,
};

function record(status: string = "ready", error: { code: string; message: string; retryable: boolean } | null = null) {
  return {
    id: "i1",
    status,
    revision: 2,
    createdAt: "2026-09-27T10:00:00Z",
    expiresAt: "2026-09-28T10:00:00Z",
    text: "Schulfest",
    attachments: [{ id: "a1", filename: "flyer.jpg", mimeType: "image/jpeg", sizeBytes: 10 }],
    draft: status === "ready" ? draft : null,
    error,
    applyResults: status === "partially_applied" ? {
      work: [], calendar: [], paperlessDocumentIds: [],
    } : null,
    homeAssistant: { workerOnline: true },
    paperlessAvailable: true,
  };
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/intake/:id" element={<IntakeReviewPage />} />
    </Routes>,
    { initialEntries: ["/intake/i1"] },
  );
}

describe("IntakeReviewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getIntake.mockResolvedValue(record() as never);
    mockedApi.updateIntakeDraft.mockImplementation(async (_id, body) => ({ ...record(), revision: 3, draft: body.draft } as never));
    mockedApi.applyIntake.mockResolvedValue({ ...record("applied"), draft: null } as never);
    mockedApi.retryIntake.mockResolvedValue(record() as never);
  });

  it("renders calendar events and Machbar items separately, warnings, and assumed duration", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Kalender" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Elternabend")).toBeInTheDocument();
    expect(screen.getByText("Machbar")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Rückmeldezettel abgeben")).toBeInTheDocument();
    expect(screen.getByText("No end time in source; 60 min assumed")).toBeInTheDocument();
    expect(screen.getByText("Dauer angenommen")).toBeInTheDocument();
  });

  it("changes the apply payload only after Übernehmen and cascades parent disabling", async () => {
    renderPage();
    await screen.findByDisplayValue("Elternabend");
    const title = screen.getByDisplayValue("Elternabend");
    fireEvent.change(title, { target: { value: "Neuer Elternabend" } });
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[2]!);
    expect((checkboxes[3] as HTMLInputElement).checked).toBe(false);
    expect(mockedApi.applyIntake).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalled());
    expect(mockedApi.applyIntake.mock.calls[0]?.[1].draft.calendarEvents[0]?.title).toBe("Neuer Elternabend");
    expect(mockedApi.applyIntake.mock.calls[0]?.[1].draft.workItems[1]?.enabled).toBe(false);
  });

  it("retries analysis failures", async () => {
    mockedApi.getIntake.mockResolvedValue(record("analysis_failed", {
      code: "ai_task_failed", message: "Analyse fehlgeschlagen", retryable: true,
    }) as never);
    renderPage();
    expect(await screen.findByText("Analyse fehlgeschlagen")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erneut analysieren" }));
    await waitFor(() => expect(mockedApi.retryIntake).toHaveBeenCalledWith("i1"));
  });

  it.each([
    ["queued", "Die Verarbeitung wartet auf Home Assistant."],
    ["analyzing", "Der Inhalt wird analysiert …"],
    ["applying", "Wird übernommen …"],
    ["applied", "Verarbeitung übernommen"],
    ["partially_applied", "Teilweise übernommen"],
  ])("renders the %s state distinctly", async (status, text) => {
    mockedApi.getIntake.mockResolvedValue(record(status) as never);
    renderPage();
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it.each([
    "home_assistant_not_connected",
    "home_assistant_protocol_outdated",
    "ai_task_not_configured",
    "ai_task_attachments_unsupported",
    "ai_task_failed",
    "ai_task_invalid_response",
    "calendar_not_configured",
    "calendar_not_writable",
    "calendar_create_failed",
    "calendar_uid_not_recovered",
    "intake_apply_partial",
    "intake_attachment_download_failed",
    "intake_expired",
    "intake_draft_invalid",
  ])("renders the error message for %s", async (code) => {
    mockedApi.getIntake.mockResolvedValue(record("analysis_failed", {
      code, message: `message:${code}`, retryable: true,
    }) as never);
    renderPage();
    expect(await screen.findByText(`message:${code}`)).toBeInTheDocument();
  });
});
