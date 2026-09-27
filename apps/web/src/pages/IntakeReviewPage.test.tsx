import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("does not autosave a loaded draft when only its revision is present", async () => {
    renderPage();
    await screen.findByDisplayValue("Elternabend");
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(mockedApi.updateIntakeDraft).not.toHaveBeenCalled();
  });

  it("debounces one actual edit by one second", async () => {
    renderPage();
    const summary = await screen.findByDisplayValue("Schulfest");
    vi.useFakeTimers();
    fireEvent.change(summary, { target: { value: "Neues Schulfest" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(mockedApi.updateIntakeDraft).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    expect(mockedApi.updateIntakeDraft.mock.calls[0]?.[1].draft.summary).toBe("Neues Schulfest");
  });

  it("saves edits made during an in-flight autosave using the newest revision", async () => {
    let finishFirst!: (value: ReturnType<typeof record>) => void;
    const firstSave = new Promise<ReturnType<typeof record>>((resolve) => {
      finishFirst = resolve;
    });
    mockedApi.updateIntakeDraft
      .mockReturnValueOnce(firstSave as never)
      .mockImplementation(async (_id, body) => ({ ...record(), revision: 4, draft: body.draft } as never));
    renderPage();
    const summary = await screen.findByDisplayValue("Schulfest");
    vi.useFakeTimers();
    fireEvent.change(summary, { target: { value: "Erster Stand" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByDisplayValue("Erster Stand"), { target: { value: "Neuester Stand" } });
    await act(async () => {
      finishFirst({ ...record(), revision: 3, draft: mockedApi.updateIntakeDraft.mock.calls[0]![1].draft } as never);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(2);
    expect(mockedApi.updateIntakeDraft.mock.calls[1]?.[1]).toMatchObject({
      expectedRevision: 3,
      draft: { summary: "Neuester Stand" },
    });
  });

  it("waits for a pending draft save before applying with its returned revision", async () => {
    let finishSave!: (value: ReturnType<typeof record>) => void;
    const save = new Promise<ReturnType<typeof record>>((resolve) => {
      finishSave = resolve;
    });
    mockedApi.updateIntakeDraft.mockReturnValueOnce(save as never);
    renderPage();
    const summary = await screen.findByDisplayValue("Schulfest");
    vi.useFakeTimers();
    fireEvent.change(summary, { target: { value: "Aktualisiert" } });
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    expect(mockedApi.applyIntake).not.toHaveBeenCalled();
    await act(async () => {
      finishSave({ ...record(), revision: 3, draft: mockedApi.updateIntakeDraft.mock.calls[0]![1].draft } as never);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedApi.applyIntake).toHaveBeenCalledTimes(1);
    expect(mockedApi.applyIntake.mock.calls[0]?.[1]).toMatchObject({
      expectedRevision: 3,
      draft: { summary: "Aktualisiert" },
    });
  });

  it("reconciles one stale-write response without autosaving the rejected snapshot again", async () => {
    mockedApi.getIntake
      .mockResolvedValueOnce(record() as never)
      .mockResolvedValueOnce({
        ...record(),
        revision: 3,
        draft: { ...draft, summary: "Server update" },
      } as never);
    mockedApi.updateIntakeDraft.mockRejectedValueOnce(
      Object.assign(new Error("stale"), { name: "ApiError", code: "stale_write_conflict" }),
    );
    renderPage();
    const summary = await screen.findByDisplayValue("Schulfest");
    vi.useFakeTimers();
    fireEvent.change(summary, { target: { value: "Local update" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedApi.getIntake).toHaveBeenCalledTimes(2);
    expect(screen.getByDisplayValue("Server update")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
  });

  it("does not PATCH an invalid all-day-to-timed draft, then saves exactly once after its end is entered", async () => {
    mockedApi.getIntake.mockResolvedValue({
      ...record(),
      draft: {
        ...draft,
        calendarEvents: [{
          ...draft.calendarEvents[0],
          allDay: true,
          startDate: "2026-10-08",
          endDate: "2026-10-08",
          startDateTime: null,
          endDateTime: null,
        }],
      },
    } as never);
    renderPage();
    const eventCard = (await screen.findByDisplayValue("Elternabend")).closest("article")!;
    vi.useFakeTimers();
    fireEvent.click(within(eventCard).getAllByRole("checkbox")[1]!);
    expect(screen.getByRole("button", { name: "Übernehmen" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(mockedApi.updateIntakeDraft).not.toHaveBeenCalled();
    fireEvent.change(within(eventCard).getByLabelText("end"), { target: { value: "2026-10-08T20:00:00+02:00" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(mockedApi.updateIntakeDraft).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-stale rejected snapshot until the draft changes", async () => {
    mockedApi.updateIntakeDraft
      .mockRejectedValueOnce(new Error("Save unavailable"))
      .mockImplementation(async (_id, body) => ({ ...record(), revision: 3, draft: body.draft } as never));
    renderPage();
    const summary = await screen.findByDisplayValue("Schulfest");
    vi.useFakeTimers();
    fireEvent.change(summary, { target: { value: "First edit" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("Save unavailable");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    fireEvent.change(summary, { target: { value: "Second edit" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(2);
    expect(mockedApi.updateIntakeDraft.mock.calls[1]?.[1].draft.summary).toBe("Second edit");
    expect(screen.queryByText("Save unavailable")).not.toBeInTheDocument();
  });

  it.each([
    ["calendar_not_configured", "Kein Kalender ist konfiguriert."],
    ["calendar_not_writable", "Der Kalender kann nicht beschrieben werden."],
    ["intake_source_retention_failed", "Das Original konnte nicht behalten werden."],
    ["unexpected_error", "Etwas ist schiefgelaufen."],
  ])("shows localized Apply failure %s and permits retry with the same draft", async (code, message) => {
    mockedApi.applyIntake.mockRejectedValueOnce(
      Object.assign(new Error("raw API text"), { name: "ApiError", code }),
    );
    renderPage();
    await screen.findByDisplayValue("Schulfest");
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByDisplayValue("Schulfest")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it("renders validation errors against the actual non-first calendar event", async () => {
    const secondEvent = {
      ...draft.calendarEvents[0]!,
      key: "second",
      title: "Zweiter Termin",
      endDateTime: null,
    };
    mockedApi.getIntake.mockResolvedValue({
      ...record(),
      draft: { ...draft, calendarEvents: [draft.calendarEvents[0]!, secondEvent] },
    } as never);
    renderPage();
    const endInputs = await screen.findAllByLabelText("end");
    expect(within(endInputs[0]!.closest("article")!).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(endInputs[1]!.closest("article")!).getByText("Enabled timed events require an end.")).toBeInTheDocument();
  });

  it("shows a warning when an all-day event transitions to a timed event without an end", async () => {
    const allDayEvent = {
      ...draft.calendarEvents[0]!,
      allDay: true,
      startDate: "2026-10-08",
      endDate: "2026-10-08",
      startDateTime: null,
      endDateTime: null,
    };
    mockedApi.getIntake.mockResolvedValue({
      ...record(),
      draft: { ...draft, calendarEvents: [allDayEvent] },
    } as never);
    renderPage();
    const eventCard = (await screen.findByDisplayValue("Elternabend")).closest("article")!;
    fireEvent.click(within(eventCard).getAllByRole("checkbox")[1]!);
    expect(within(eventCard).getByText("Bitte eine Endzeit ergänzen; es wird keine Dauer angenommen.")).toBeInTheDocument();
    expect(within(eventCard).getByLabelText("end")).toHaveValue("");
  });

  it("supports a date-only availability value and keeps the API pair coherent", async () => {
    renderPage();
    const dates = await screen.findAllByLabelText("Ab");
    fireEvent.change(dates[0]!, { target: { value: "2026-10-12" } });
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalled());
    const availability = mockedApi.applyIntake.mock.calls[0]?.[1].draft.workItems[0];
    expect(availability?.notBeforeDate).toBe("2026-10-12");
    expect(availability?.notBeforeAt).toBeTruthy();
    expect(new Date(availability!.notBeforeAt!).getHours()).toBe(0);
  });

  it("changes a timed availability date and clears both date and time fields", async () => {
    renderPage();
    const dates = await screen.findAllByLabelText("Ab");
    fireEvent.change(dates[0]!, { target: { value: "2026-10-12" } });
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Uhrzeit" })[0]!);
    fireEvent.change(screen.getByDisplayValue("08:00"), { target: { value: "17:30" } });
    fireEvent.change(dates[0]!, { target: { value: "2026-10-13" } });
    expect(dates[0]).toHaveValue("2026-10-13");
    expect(screen.getByDisplayValue("17:30")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Ab-Datum entfernen" })[0]!);
    expect(dates[0]).toHaveValue("");
    expect(screen.getAllByRole("checkbox", { name: "Uhrzeit" })[0]).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalled());
    const availability = mockedApi.applyIntake.mock.calls[0]?.[1].draft.workItems[0];
    expect(availability?.notBeforeDate).toBeNull();
    expect(availability?.notBeforeAt).toBeNull();
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
