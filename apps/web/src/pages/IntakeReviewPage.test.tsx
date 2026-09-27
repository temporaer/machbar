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

vi.mock("../components/ClockTimePicker", () => ({
  ClockTimePicker: ({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) =>
    <input id={id} type="time" value={value} onChange={(event) => onChange(event.target.value)} />,
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
    expect(screen.getByText("Schulfest")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Schulfest")).not.toBeInTheDocument();
  });

  it("renders an empty summary without an editable summary field", async () => {
    mockedApi.getIntake.mockResolvedValue({ ...record(), draft: { ...draft, summary: "" } } as never);
    renderPage();
    await screen.findByDisplayValue("Elternabend");
    expect(screen.queryByDisplayValue("Schulfest")).not.toBeInTheDocument();
    expect(screen.queryByText("Schulfest")).not.toBeInTheDocument();
  });

  it.each([
    ["Beginn", "Elternabend"],
    ["Ende", "Elternabend"],
    ["Fällig", "Rückmeldezettel abgeben"],
    ["Geplant für", "Rückmeldezettel abgeben"],
    ["Erinnerung", "Rückmeldezettel abgeben"],
  ])("blocks Apply for an invalid %s date and enables it when corrected", async (label, title) => {
    renderPage();
    const card = (await screen.findByDisplayValue(title)).closest("article")!;
    const input = within(card).getByLabelText(label);
    fireEvent.change(input, { target: { value: "not a date" } });
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(within(card).getByText("Datum nicht erkannt")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "Übernehmen" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    expect(mockedApi.applyIntake).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: label === "Geplant für" ? "01.10.2026" : "08.10.2026" } });
    fireEvent.blur(input);
    expect(screen.getByRole("button", { name: "Übernehmen" })).toBeEnabled();
  });

  it("forgets invalid calendar and work dates when their controls disappear", async () => {
    renderPage();
    const eventCard = (await screen.findByDisplayValue("Elternabend")).closest("article")!;
    const start = within(eventCard).getByLabelText("Beginn");
    fireEvent.change(start, { target: { value: "not a date" } });
    fireEvent.blur(start);
    expect(screen.getByRole("button", { name: "Übernehmen" })).toBeDisabled();
    fireEvent.click(within(eventCard).getByRole("checkbox", { name: "Ganztägig" }));
    expect(within(eventCard).getByLabelText("Beginn")).toHaveAttribute("type", "date");
    expect(screen.getByRole("button", { name: "Übernehmen" })).toBeEnabled();

    const workCard = screen.getByDisplayValue("Rückmeldezettel abgeben").closest("article")!;
    const due = within(workCard).getByLabelText("Fällig");
    fireEvent.change(due, { target: { value: "not a date" } });
    fireEvent.blur(due);
    expect(screen.getByRole("button", { name: "Übernehmen" })).toBeDisabled();
    fireEvent.change(within(workCard).getAllByRole("combobox")[0]!, { target: { value: "reference" } });
    expect(within(workCard).queryByLabelText("Fällig")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Übernehmen" })).toBeEnabled();
  });

  it.each([
    ["calendar", { ...draft, workItems: [] }],
    ["work", { ...draft, calendarEvents: [] }],
  ])("only displays the %s heading when that section has items", async (section, sectionDraft) => {
    mockedApi.getIntake.mockResolvedValue({ ...record(), draft: sectionDraft } as never);
    renderPage();
    expect(await screen.findByRole("heading", { name: "Vorschlag prüfen" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Kalender" }) !== null).toBe(section === "calendar");
    expect(screen.queryByRole("heading", { name: "Machbar" }) !== null).toBe(section === "work");
  });

  it("shows the offline hint while applying without an online Home Assistant worker", async () => {
    mockedApi.getIntake.mockResolvedValue({ ...record("applying"), homeAssistant: { workerOnline: false } } as never);
    renderPage();
    expect(await screen.findByText("Wird übernommen …")).toBeInTheDocument();
    expect(screen.getByText("Home Assistant ist gerade nicht erreichbar – die Verarbeitung läuft weiter, sobald es wieder online ist.")).toHaveAttribute("role", "status");
  });

  it("uses localized all-day and kind choices with date-only inputs", async () => {
    mockedApi.getIntake.mockResolvedValue({
      ...record(),
      draft: { ...draft, calendarEvents: [{ ...draft.calendarEvents[0]!, allDay: true, startDate: "2026-10-08", endDate: "2026-10-08", startDateTime: null, endDateTime: null }] },
    } as never);
    renderPage();
    const card = (await screen.findByDisplayValue("Elternabend")).closest("article")!;
    expect(within(card).getByRole("checkbox", { name: "Ganztägig" })).toBeChecked();
    expect(within(card).getByLabelText("Beginn")).toHaveAttribute("type", "date");
    expect(within(card).getByLabelText("Ende")).toHaveAttribute("type", "date");
    const kind = screen.getAllByRole("combobox")[0]!;
    expect(within(kind).getByRole("option", { name: "Aufgabe" })).toBeInTheDocument();
    expect(within(kind).getByRole("option", { name: "Projekt" })).toBeInTheDocument();
    expect(within(kind).getByRole("option", { name: "Material" })).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText("Ende"), { target: { value: "2026-10-09" } });
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalledTimes(1));
    expect(mockedApi.applyIntake.mock.calls[0]?.[1].draft?.calendarEvents[0]?.endDate).toBe("2026-10-09");
  });

  it("writes calendar and reminder local date/time controls as canonical ISO values", async () => {
    renderPage();
    const eventCard = (await screen.findByDisplayValue("Elternabend")).closest("article")!;
    fireEvent.change(within(eventCard).getByLabelText("Beginn"), { target: { value: "09.10.2026" } });
    fireEvent.blur(within(eventCard).getByLabelText("Beginn"));
    fireEvent.change(within(eventCard).getAllByLabelText("Uhrzeit")[0]!, { target: { value: "16:30" } });
    fireEvent.change(within(eventCard).getByLabelText("Ende"), { target: { value: "09.10.2026" } });
    fireEvent.blur(within(eventCard).getByLabelText("Ende"));
    const workCard = (screen.getByDisplayValue("Rückmeldezettel abgeben")).closest("article")!;
    fireEvent.change(within(workCard).getByLabelText("Fällig"), { target: { value: "20.10.2026" } });
    fireEvent.blur(within(workCard).getByLabelText("Fällig"));
    fireEvent.change(within(workCard).getByLabelText("Geplant für"), { target: { value: "11.10.2026" } });
    fireEvent.blur(within(workCard).getByLabelText("Geplant für"));
    fireEvent.change(within(workCard).getByLabelText("Erinnerung"), { target: { value: "10.10.2026" } });
    fireEvent.blur(within(workCard).getByLabelText("Erinnerung"));
    fireEvent.change(within(workCard).getAllByLabelText("Uhrzeit")[1]!, { target: { value: "08:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalledTimes(1));
    const applied = mockedApi.applyIntake.mock.calls[0]![1].draft!;
    expect(applied.calendarEvents[0]?.startDateTime).toBe(new Date(2026, 9, 9, 16, 30).toISOString());
    expect(applied.workItems[0]).toMatchObject({
      dueDate: "2026-10-20",
      scheduledDate: "2026-10-11",
      reminderAt: new Date(2026, 9, 10, 8, 30).toISOString(),
    });
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
    expect(mockedApi.applyIntake.mock.calls[0]?.[1].draft?.calendarEvents[0]?.title).toBe("Neuer Elternabend");
    expect(mockedApi.applyIntake.mock.calls[0]?.[1].draft?.workItems[1]?.enabled).toBe(false);
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
    const title = await screen.findByDisplayValue("Elternabend");
    vi.useFakeTimers();
    fireEvent.change(title, { target: { value: "Neuer Termin" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(mockedApi.updateIntakeDraft).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    expect(mockedApi.updateIntakeDraft.mock.calls[0]?.[1].draft.calendarEvents[0]?.title).toBe("Neuer Termin");
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
    const title = await screen.findByDisplayValue("Elternabend");
    vi.useFakeTimers();
    fireEvent.change(title, { target: { value: "Erster Stand" } });
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
      draft: { calendarEvents: [expect.objectContaining({ title: "Neuester Stand" })] },
    });
  });

  it("waits for a pending draft save before applying with its returned revision", async () => {
    let finishSave!: (value: ReturnType<typeof record>) => void;
    const save = new Promise<ReturnType<typeof record>>((resolve) => {
      finishSave = resolve;
    });
    mockedApi.updateIntakeDraft.mockReturnValueOnce(save as never);
    renderPage();
    const title = await screen.findByDisplayValue("Elternabend");
    vi.useFakeTimers();
    fireEvent.change(title, { target: { value: "Aktualisiert" } });
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
      draft: { calendarEvents: [expect.objectContaining({ title: "Aktualisiert" })] },
    });
  });

  it("reconciles one stale-write response without autosaving the rejected snapshot again", async () => {
    mockedApi.getIntake
      .mockResolvedValueOnce(record() as never)
      .mockResolvedValueOnce({
        ...record(),
        revision: 3,
        draft: { ...draft, calendarEvents: [{ ...draft.calendarEvents[0]!, title: "Server update" }] },
      } as never);
    mockedApi.updateIntakeDraft.mockRejectedValueOnce(
      Object.assign(new Error("stale"), { name: "ApiError", code: "stale_write_conflict" }),
    );
    renderPage();
    const title = await screen.findByDisplayValue("Elternabend");
    vi.useFakeTimers();
    fireEvent.change(title, { target: { value: "Local update" } });
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
    fireEvent.change(within(eventCard).getByLabelText("Ende"), { target: { value: "08.10.2026" } });
    fireEvent.blur(within(eventCard).getByLabelText("Ende"));
    fireEvent.change(within(eventCard).getAllByLabelText("Uhrzeit")[1]!, { target: { value: "20:00" } });
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
    const title = await screen.findByDisplayValue("Elternabend");
    vi.useFakeTimers();
    fireEvent.change(title, { target: { value: "First edit" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("Save unavailable");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    fireEvent.change(title, { target: { value: "Second edit" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(2);
    expect(mockedApi.updateIntakeDraft.mock.calls[1]?.[1].draft.calendarEvents[0]?.title).toBe("Second edit");
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
    await screen.findByDisplayValue("Elternabend");
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByDisplayValue("Elternabend")).toBeInTheDocument();
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
    const endInputs = await screen.findAllByLabelText("Ende");
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
    expect(within(eventCard).getByLabelText("Ende")).toHaveValue("");
  });

  it("supports a date-only availability value and keeps the API pair coherent", async () => {
    renderPage();
    const dates = await screen.findAllByLabelText("Ab");
    fireEvent.change(dates[0]!, { target: { value: "2026-10-12" } });
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalled());
    const availability = mockedApi.applyIntake.mock.calls[0]?.[1].draft?.workItems[0];
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
    const availability = mockedApi.applyIntake.mock.calls[0]?.[1].draft?.workItems[0];
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

  it("shows persisted partial errors and created work without rendering editors", async () => {
    mockedApi.getIntake.mockResolvedValue({
      ...record("partially_applied", {
        code: "intake_apply_partial",
        message: "Previous Apply was interrupted and can be retried.",
        retryable: true,
      }),
      draft: {
        ...draft,
        calendarEvents: [{ ...draft.calendarEvents[0]!, key: "failed-event", title: "Elternabend" }],
        workItems: [{ ...draft.workItems[0]!, key: "created", title: "Rückmeldezettel abgeben" }],
      },
      applyResults: {
        work: [{ key: "created", role: "task", kind: "action", workItemId: 27 }],
        calendar: [
          { key: "failed-event", status: "failed", correlationId: "c1", error: { code: "calendar_create_failed", message: "Calendar creation failed", retryable: true }, event: null },
          { key: "pending-event", status: "pending", correlationId: "c2", error: null, event: null },
        ],
        paperlessDocumentIds: [],
      },
    } as never);
    renderPage();
    expect(await screen.findByRole("heading", { name: "Teilweise übernommen" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rückmeldezettel abgeben" })).toHaveAttribute("href", "/tasks/27");
    expect(screen.getByText("Previous Apply was interrupted and can be retried.")).toHaveAttribute("role", "alert");
    expect(screen.getByText("Elternabend: Calendar creation failed")).toHaveAttribute("role", "alert");
    expect(screen.queryByText("pending-event")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(mockedApi.updateIntakeDraft).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Zu Machbar" })).toHaveAttribute("href", "/today");
  });

  it("provides an exit for calendar-only applied results with no created work", async () => {
    mockedApi.getIntake.mockResolvedValue({
      ...record("applied"),
      draft: { ...draft, workItems: [] },
      applyResults: { work: [], calendar: [{ key: "event", status: "succeeded", correlationId: "c1", error: null, event: null }], paperlessDocumentIds: [] },
    } as never);
    renderPage();
    expect(await screen.findByRole("heading", { name: "Verarbeitung übernommen" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zu Machbar" })).toHaveAttribute("href", "/today");
  });

  it("retries a partial result exactly once without requiring a valid draft or PATCH", async () => {
    mockedApi.getIntake.mockResolvedValue({
      ...record("partially_applied"),
      draft: { ...draft, calendarEvents: [{ ...draft.calendarEvents[0]!, endDateTime: null }] },
    } as never);
    renderPage();
    await screen.findByRole("heading", { name: "Teilweise übernommen" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalledTimes(1));
    expect(mockedApi.applyIntake).toHaveBeenCalledWith("i1", { expectedRevision: 2 });
    expect(mockedApi.updateIntakeDraft).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Verarbeitung übernommen" })).toBeInTheDocument();
  });

  it.each([
    ["calendar_not_configured", "Kein Kalender ist konfiguriert."],
    ["unexpected_error", "Etwas ist schiefgelaufen."],
  ])("displays synchronous partial retry failure %s and clears it on success", async (code, message) => {
    mockedApi.getIntake.mockResolvedValue(record("partially_applied") as never);
    mockedApi.applyIntake.mockRejectedValueOnce(
      Object.assign(new Error("raw API text"), { name: "ApiError", code }),
    );
    renderPage();
    await screen.findByRole("heading", { name: "Teilweise übernommen" });
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("heading", { name: "Teilweise übernommen" })).toBeInTheDocument();
    expect(mockedApi.applyIntake).toHaveBeenCalledTimes(1);
    expect(mockedApi.updateIntakeDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalledTimes(2));
    expect(mockedApi.applyIntake.mock.calls[1]?.[1]).toEqual({ expectedRevision: 2 });
    expect(screen.queryByText(message)).not.toBeInTheDocument();
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
