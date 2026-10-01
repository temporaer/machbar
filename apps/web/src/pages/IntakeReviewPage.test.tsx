import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Routes, Route } from "react-router-dom";
import type { IntakeDraft } from "@machbar/shared";
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

const draft: IntakeDraft = {
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
    reminders: [],
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
    reminders: [],
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
    retryHint: null,
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

async function openEditor(title: string) {
  const card = (await screen.findByRole("heading", { name: title })).closest("article")!;
  fireEvent.click(
    within(card).getByRole("button", { name: `Bearbeiten: ${title}` }),
  );
  return within(await screen.findByRole("dialog"));
}

async function openWorkPropertyEditor(title: string, propertyName: string) {
  const card = (await screen.findByRole("heading", { name: title })).closest("article")!;
  fireEvent.click(within(card).getByRole("button", { name: propertyName }));
  return within(await screen.findByRole("dialog"));
}

function applyButton() {
  return screen.getByRole("button", { name: /übernehmen$/i });
}

function authoredSection(editor: ReturnType<typeof within>, label: string) {
  const match = editor
    .getAllByText(label, { exact: true })
    .find((element: HTMLElement) => element.tagName === "STRONG");
  const section = match?.closest("section");
  if (!section) throw new Error(`Could not find authored field: ${label}`);
  return section;
}

function editTitleButton(editor: ReturnType<typeof within>) {
  const titleSection = authoredSection(editor, "Titel");
  return within(titleSection).getByRole("button", { name: "Bearbeiten" });
}

async function changeTitle(editor: ReturnType<typeof within>, title: string) {
  const editButtons = editor.queryAllByRole("button", { name: "Bearbeiten" });
  if (editButtons.length > 0) fireEvent.click(editButtons[0]!);
  fireEvent.change(editor.getByRole("textbox", { name: "Titel" }), {
    target: { value: title },
  });
  const titleSection = authoredSection(editor, "Titel");
  fireEvent.click(within(titleSection).getByRole("button", { name: "Speichern" }));
}

function closeEditor(editor: ReturnType<typeof within>) {
  fireEvent.click(editor.getByRole("button", { name: "Schließen" }));
}

function authoredField(editor: ReturnType<typeof within>, label: string) {
  const match = editor
    .getAllByText(label, { exact: true })
    .find((element: HTMLElement) => element.tagName === "STRONG");
  const section = match?.closest("section");
  if (!section) throw new Error(`Could not find authored field: ${label}`);
  return within(section);
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

  it("renders compact approval cards without exposing the full editors", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Kalender" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Elternabend" })).toBeInTheDocument();
    expect(screen.getByText("Machbar")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Rückmeldezettel abgeben" })).toBeInTheDocument();
    expect(screen.getByText("No end time in source; 60 min assumed")).toBeInTheDocument();
    expect(screen.getByText("Dauer angenommen")).toBeInTheDocument();
    expect(screen.getByText("Schulfest")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Schulfest")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3 Elemente übernehmen" })).toBeInTheDocument();
  });

  it("renders an empty summary without an editable summary field", async () => {
    mockedApi.getIntake.mockResolvedValue({ ...record(), draft: { ...draft, summary: "" } } as never);
    renderPage();
    await screen.findByRole("heading", { name: "Elternabend" });
    expect(screen.queryByDisplayValue("Schulfest")).not.toBeInTheDocument();
    expect(screen.queryByText("Schulfest")).not.toBeInTheDocument();
  });

  it("renders existing metadata compactly and omits unset controls", async () => {
    renderPage();
    const card = (await screen.findByRole("heading", { name: "Rückmeldezettel abgeben" })).closest("article")!;
    expect(within(card).getByText("Aufgabe")).toBeInTheDocument();
    expect(within(card).getByText("Mira")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Fällig: 02.10.2026" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "+ Geplant für" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "+ Ab" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "+ Erinnerung" })).toBeInTheDocument();
    expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(card).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("opens focused editors and cancels authored title and notes without changing the draft", async () => {
    mockedApi.getIntake.mockResolvedValue({
      ...record(),
      draft: {
        ...draft,
        workItems: [
          { ...draft.workItems[0]!, notes: "Original **note**" },
          draft.workItems[1]!,
        ],
      },
    } as never);
    renderPage();
    const editor = await openEditor("Rückmeldezettel abgeben");
    expect(editor.getByRole("combobox", { name: "Art" })).toBeInTheDocument();
    expect(editor.queryByRole("group", { name: "Zuständig" })).not.toBeInTheDocument();
    expect(editor.getByText("Original", { exact: false })).toBeInTheDocument();

    fireEvent.click(editTitleButton(editor));
    fireEvent.change(editor.getByRole("textbox", { name: "Titel" }), {
      target: { value: "Uncommitted title" },
    });
    fireEvent.click(authoredField(editor, "Titel").getByRole("button", { name: "Abbrechen" }));
    fireEvent.click(authoredField(editor, "Notizen").getByRole("button", { name: "Bearbeiten" }));
    fireEvent.change(editor.getByRole("textbox", { name: "Notizen" }), {
      target: { value: "Uncommitted note" },
    });
    fireEvent.click(authoredField(editor, "Notizen").getByRole("button", { name: "Abbrechen" }));
    closeEditor(editor);

    expect(screen.getByRole("heading", { name: "Rückmeldezettel abgeben" })).toBeInTheDocument();
    expect(screen.getByText("Original", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("Uncommitted title")).not.toBeInTheDocument();
    expect(screen.queryByText("Uncommitted note")).not.toBeInTheDocument();
    expect(mockedApi.updateIntakeDraft).not.toHaveBeenCalled();
  });

  it("cancels calendar authored edits without changing the intake draft", async () => {
    renderPage();
    const editor = await openEditor("Elternabend");
    const title = editor.getByRole("textbox", { name: "Titel" });
    fireEvent.change(title, { target: { value: "Uncommitted event title" } });
    fireEvent.click(authoredField(editor, "Titel").getByRole("button", { name: "Abbrechen" }));
    expect(title).toHaveValue("Elternabend");
    closeEditor(editor);
    expect(screen.getByRole("heading", { name: "Elternabend" })).toBeInTheDocument();
    expect(mockedApi.updateIntakeDraft).not.toHaveBeenCalled();
  });

  it("updates owner selection immediately in the intake draft", async () => {
    renderPage();
    const editor = await openWorkPropertyEditor("Rückmeldezettel abgeben", "Zuständig: Mira");
    expect(editor.getByRole("group", { name: "Zuständig" })).toBeInTheDocument();
    fireEvent.click(editor.getByRole("button", { name: "Gemeinsam" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(applyButton());
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalledTimes(1));
    expect(mockedApi.applyIntake.mock.calls[0]?.[1].draft?.workItems[0]?.ownerMemberId).toBeNull();
  });

  it("opens unset pills in focused editors and updates only the selected property", async () => {
    renderPage();
    const editor = await openWorkPropertyEditor("Rückmeldezettel abgeben", "+ Geplant für");
    expect(editor.getByRole("textbox", { name: "Geplant für" })).toBeInTheDocument();
    expect(editor.queryByLabelText("Fällig")).not.toBeInTheDocument();
    expect(editor.queryByLabelText("Ab")).not.toBeInTheDocument();
    const date = editor.getByRole("textbox", { name: "Geplant für" });
    fireEvent.change(date, { target: { value: "12.10.2026" } });
    fireEvent.blur(date);
    closeEditor(editor);

    const card = screen.getByRole("heading", { name: "Rückmeldezettel abgeben" }).closest("article")!;
    const scheduledPill = within(card).getByRole("button", { name: "Geplant für: 12.10.2026" });
    expect(scheduledPill).toBeInTheDocument();
    fireEvent.click(scheduledPill);
    const focusedEditor = within(await screen.findByRole("dialog"));
    expect(focusedEditor.getByRole("textbox", { name: "Geplant für" })).toHaveValue("12.10.2026");
    expect(focusedEditor.queryByLabelText("Fällig")).not.toBeInTheDocument();
    expect(focusedEditor.queryByLabelText("Ab")).not.toBeInTheDocument();
    closeEditor(focusedEditor);
  });

  it("autosaves a valid committed property edit normally", async () => {
    renderPage();
    const editor = await openWorkPropertyEditor("Rückmeldezettel abgeben", "Fällig: 02.10.2026");
    vi.useFakeTimers();
    const date = editor.getByRole("textbox", { name: "Fällig" });
    fireEvent.change(date, { target: { value: "20.10.2026" } });
    fireEvent.blur(date);
    expect(applyButton()).toBeEnabled();
    closeEditor(editor);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(mockedApi.updateIntakeDraft).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    expect(mockedApi.updateIntakeDraft.mock.calls[0]?.[1].draft.workItems[0]).toMatchObject({
      dueDate: "2026-10-20",
      scheduledDate: null,
      notBeforeDate: null,
      reminders: [],
    });
  });

  it("clears an invalid local date when its focused editor is dismissed", async () => {
    renderPage();
    const editor = await openEditor("Elternabend");
    const start = editor.getByRole("textbox", { name: "Beginn" });
    fireEvent.change(start, { target: { value: "32.13.2026" } });
    fireEvent.blur(start);
    expect(start).toHaveAttribute("aria-invalid", "true");
    closeEditor(editor);
    const card = screen.getByRole("heading", { name: "Elternabend" }).closest("article")!;
    expect(within(card).queryByText(/Ungültige Datumseingabe/)).not.toBeInTheDocument();
    expect(applyButton()).toBeEnabled();
    const reopenedEditor = await openEditor("Elternabend");
    const reopenedStart = reopenedEditor.getByRole("textbox", { name: "Beginn" });
    expect(reopenedStart).toHaveValue("08.10.2026");
    expect(applyButton()).toBeEnabled();
    closeEditor(reopenedEditor);
  });

  it("uses the enabled proposal count and allows disabled cards to be restored", async () => {
    renderPage();
    const eventCard = (await screen.findByRole("heading", { name: "Elternabend" })).closest("article")!;
    expect(applyButton()).toHaveTextContent("3 Elemente übernehmen");
    fireEvent.click(within(eventCard).getByRole("checkbox", { name: "In Vorschlag übernehmen: Elternabend" }));
    expect(eventCard).toHaveClass("intake-proposal-disabled");
    expect(applyButton()).toHaveTextContent("2 Elemente übernehmen");
    fireEvent.click(within(eventCard).getByRole("checkbox", { name: "In Vorschlag übernehmen: Elternabend" }));
    expect(eventCard).not.toHaveClass("intake-proposal-disabled");
    expect(applyButton()).toHaveTextContent("3 Elemente übernehmen");
  });

  it("clears fields that are illegal when changing the proposed work kind", async () => {
    mockedApi.getIntake.mockResolvedValue({
      ...record(),
      draft: {
        ...draft,
        workItems: [
          {
            ...draft.workItems[0]!,
            scheduledDate: "2026-10-03",
            notBeforeDate: "2026-10-04",
            notBeforeAt: "2026-10-04T00:00:00.000Z",
            reminders: [{ kind: "absolute", at: "2026-10-02T08:00:00.000Z" }],
            needsClarification: true,
          },
          draft.workItems[1]!,
        ],
      },
    } as never);
    renderPage();
    const editor = await openEditor("Rückmeldezettel abgeben");
    fireEvent.change(editor.getByRole("combobox", { name: "Art" }), {
      target: { value: "project" },
    });
    closeEditor(editor);
    fireEvent.click(applyButton());
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalledTimes(1));
    expect(mockedApi.applyIntake.mock.calls[0]?.[1].draft?.workItems[0]).toMatchObject({
      kind: "project",
      scheduledDate: null,
      notBeforeDate: null,
      notBeforeAt: null,
      reminders: [],
      needsClarification: false,
    });
  });

  it.each([
    ["Beginn", "Elternabend", null],
    ["Ende", "Elternabend", null],
    ["Fällig", "Rückmeldezettel abgeben", "Fällig: 02.10.2026"],
    ["Geplant für", "Rückmeldezettel abgeben", "+ Geplant für"],
    ["Erinnerung", "Rückmeldezettel abgeben", "+ Erinnerung"],
  ])("blocks Apply for an invalid %s date while visible and clears it on dismiss", async (label, title, propertyName) => {
    renderPage();
    const editor = propertyName
      ? await openWorkPropertyEditor(title, propertyName)
      : await openEditor(title);
    const input = editor.getByRole("textbox", { name: label });
    expect(input).toHaveAttribute("type", "text");
    fireEvent.change(input, { target: { value: "32.13.2026" } });
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(editor.getByText("Datum nicht erkannt")).toHaveAttribute("role", "alert");
    expect(applyButton()).toBeDisabled();
    closeEditor(editor);
    expect(applyButton()).toBeEnabled();
    const card = screen.getByRole("heading", { name: title }).closest("article")!;
    expect(within(card).queryByText(/Ungültige Datumseingabe/)).not.toBeInTheDocument();
    const reopenedEditor = propertyName
      ? await openWorkPropertyEditor(title, propertyName)
      : await openEditor(title);
    const reopenedInput = reopenedEditor.getByRole("textbox", { name: label });
    expect(reopenedInput).toHaveValue(
      label === "Beginn" ? "08.10.2026" :
      label === "Ende" ? "08.10.2026" :
      label === "Fällig" ? "02.10.2026" : "",
    );
    expect(applyButton()).toBeEnabled();
    closeEditor(reopenedEditor);
  });

  it("forgets invalid calendar and work dates when their controls disappear", async () => {
    renderPage();
    const eventEditor = await openEditor("Elternabend");
    const start = eventEditor.getByRole("textbox", { name: "Beginn" });
    fireEvent.change(start, { target: { value: "32.13.2026" } });
    fireEvent.blur(start);
    expect(start).toHaveAttribute("aria-invalid", "true");
    expect(applyButton()).toBeDisabled();
    fireEvent.click(eventEditor.getByRole("checkbox", { name: "Ganztägig" }));
    expect(eventEditor.getByLabelText("Beginn")).toHaveAttribute("type", "date");
    expect(applyButton()).toBeEnabled();
    closeEditor(eventEditor);

    const workEditor = await openWorkPropertyEditor("Rückmeldezettel abgeben", "Fällig: 02.10.2026");
    const due = workEditor.getByRole("textbox", { name: "Fällig" });
    fireEvent.change(due, { target: { value: "32.13.2026" } });
    fireEvent.blur(due);
    expect(due).toHaveAttribute("aria-invalid", "true");
    expect(applyButton()).toBeDisabled();
    closeEditor(workEditor);
    expect(applyButton()).toBeEnabled();
    const contentEditor = await openEditor("Rückmeldezettel abgeben");
    fireEvent.change(contentEditor.getByRole("combobox", { name: "Art" }), { target: { value: "reference" } });
    expect(contentEditor.queryByLabelText("Fällig")).not.toBeInTheDocument();
    expect(applyButton()).toBeEnabled();
    closeEditor(contentEditor);
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
    const editor = await openEditor("Elternabend");
    expect(editor.getByRole("checkbox", { name: "Ganztägig" })).toBeChecked();
    expect(editor.getByLabelText("Beginn")).toHaveAttribute("type", "date");
    expect(editor.getByLabelText("Ende")).toHaveAttribute("type", "date");
    closeEditor(editor);
    const workEditor = await openEditor("Rückmeldezettel abgeben");
    const kind = workEditor.getByRole("combobox", { name: "Art" });
    expect(within(kind).getByRole("option", { name: "Aufgabe" })).toBeInTheDocument();
    expect(within(kind).getByRole("option", { name: "Projekt" })).toBeInTheDocument();
    expect(within(kind).getByRole("option", { name: "Material" })).toBeInTheDocument();
    closeEditor(workEditor);
    const eventEditor = await openEditor("Elternabend");
    fireEvent.change(eventEditor.getByLabelText("Ende"), { target: { value: "2026-10-09" } });
    closeEditor(eventEditor);
    fireEvent.click(applyButton());
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalledTimes(1));
    expect(mockedApi.applyIntake.mock.calls[0]?.[1].draft?.calendarEvents[0]?.endDate).toBe("2026-10-09");
  });

  it("writes calendar and reminder local date/time controls as canonical ISO values", async () => {
    renderPage();
    const eventEditor = await openEditor("Elternabend");
    const eventStart = eventEditor.getByLabelText("Beginn");
    fireEvent.change(eventStart, { target: { value: "09.10.2026" } });
    fireEvent.blur(eventStart);
    fireEvent.change(eventEditor.getAllByLabelText("Uhrzeit")[0]!, { target: { value: "16:30" } });
    const eventEnd = eventEditor.getByLabelText("Ende");
    fireEvent.change(eventEnd, { target: { value: "09.10.2026" } });
    fireEvent.blur(eventEnd);
    closeEditor(eventEditor);
    const workEditor = await openWorkPropertyEditor("Rückmeldezettel abgeben", "Fällig: 02.10.2026");
    const due = workEditor.getByLabelText("Fällig");
    fireEvent.change(due, { target: { value: "20.10.2026" } });
    fireEvent.blur(due);
    closeEditor(workEditor);
    const planningEditor = await openWorkPropertyEditor("Rückmeldezettel abgeben", "+ Geplant für");
    const scheduled = planningEditor.getByLabelText("Geplant für");
    fireEvent.change(scheduled, { target: { value: "11.10.2026" } });
    fireEvent.blur(scheduled);
    closeEditor(planningEditor);
    const reminderEditor = await openWorkPropertyEditor("Rückmeldezettel abgeben", "+ Erinnerung");
    const reminder = reminderEditor.getByLabelText("Erinnerung");
    fireEvent.change(reminder, { target: { value: "10.10.2026" } });
    fireEvent.blur(reminder);
    fireEvent.change(reminderEditor.getByLabelText("Uhrzeit"), { target: { value: "08:30" } });
    closeEditor(reminderEditor);
    fireEvent.click(applyButton());
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalledTimes(1));
    const applied = mockedApi.applyIntake.mock.calls[0]![1].draft!;
    expect(applied.calendarEvents[0]?.startDateTime).toBe(new Date(2026, 9, 9, 16, 30).toISOString());
    expect(applied.workItems[0]).toMatchObject({
      dueDate: "2026-10-20",
      scheduledDate: "2026-10-11",
      reminders: [{ kind: "absolute", at: new Date(2026, 9, 10, 8, 30).toISOString() }],
    });
  });

  it("changes the apply payload only after Übernehmen and cascades parent disabling", async () => {
    renderPage();
    const eventEditor = await openEditor("Elternabend");
    await changeTitle(eventEditor, "Neuer Elternabend");
    closeEditor(eventEditor);
    const parent = (await screen.findByRole("heading", { name: "Rückmeldezettel abgeben" })).closest("article")!;
    fireEvent.click(within(parent).getByRole("checkbox", { name: "In Vorschlag übernehmen: Rückmeldezettel abgeben" }));
    const child = screen.getByRole("checkbox", { name: "In Vorschlag übernehmen: Formular mitbringen" });
    expect(child).not.toBeChecked();
    expect(mockedApi.applyIntake).not.toHaveBeenCalled();
    fireEvent.click(applyButton());
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalled());
    expect(mockedApi.applyIntake.mock.calls[0]?.[1].draft?.calendarEvents[0]?.title).toBe("Neuer Elternabend");
    expect(mockedApi.applyIntake.mock.calls[0]?.[1].draft?.workItems[1]?.enabled).toBe(false);
  });

  it("does not autosave a loaded draft when only its revision is present", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Elternabend" });
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(mockedApi.updateIntakeDraft).not.toHaveBeenCalled();
  });

  it("debounces one actual edit by one second", async () => {
    renderPage();
    const editor = await openEditor("Elternabend");
    vi.useFakeTimers();
    await changeTitle(editor, "Neuer Termin");
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
    const editor = await openEditor("Elternabend");
    vi.useFakeTimers();
    await changeTitle(editor, "Erster Stand");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    await changeTitle(editor, "Neuester Stand");
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
    const editor = await openEditor("Elternabend");
    vi.useFakeTimers();
    await changeTitle(editor, "Aktualisiert");
    closeEditor(editor);
    fireEvent.click(applyButton());
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
    const editor = await openEditor("Elternabend");
    vi.useFakeTimers();
    await changeTitle(editor, "Local update");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedApi.getIntake).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Server update" })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
  });

  it("saves an unresolved timed-event draft, then saves the corrected end exactly once more", async () => {
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
    const eventEditor = await openEditor("Elternabend");
    vi.useFakeTimers();
    fireEvent.click(eventEditor.getByRole("checkbox", { name: "Ganztägig" }));
    expect(applyButton()).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    const endDate = eventEditor.getByLabelText("Ende");
    fireEvent.change(endDate, { target: { value: "08.10.2026" } });
    fireEvent.blur(endDate);
    fireEvent.change(eventEditor.getAllByLabelText("Uhrzeit")[1]!, { target: { value: "20:00" } });
    closeEditor(eventEditor);
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-stale rejected snapshot until the draft changes", async () => {
    mockedApi.updateIntakeDraft
      .mockRejectedValueOnce(new Error("Save unavailable"))
      .mockImplementation(async (_id, body) => ({ ...record(), revision: 3, draft: body.draft } as never));
    renderPage();
    const editor = await openEditor("Elternabend");
    vi.useFakeTimers();
    await changeTitle(editor, "First edit");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("Save unavailable");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mockedApi.updateIntakeDraft).toHaveBeenCalledTimes(1);
    await changeTitle(editor, "Second edit");
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
    await screen.findByRole("heading", { name: "Elternabend" });
    fireEvent.click(applyButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("heading", { name: "Elternabend" })).toBeInTheDocument();
    fireEvent.click(applyButton());
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
    const firstCard = (await screen.findByRole("heading", { name: "Elternabend" })).closest("article")!;
    const secondCard = screen.getByRole("heading", { name: "Zweiter Termin" }).closest("article")!;
    expect(within(firstCard).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(secondCard).getByText("Enabled timed events require an end.")).toBeInTheDocument();
    const editor = await openEditor("Zweiter Termin");
    expect(editor.getByText("Enabled timed events require an end.")).toBeInTheDocument();
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
    const editor = await openEditor("Elternabend");
    fireEvent.click(editor.getByRole("checkbox", { name: "Ganztägig" }));
    const card = screen.getByRole("heading", { name: "Elternabend" }).closest("article")!;
    expect(within(card).getByText("Bitte eine Endzeit ergänzen; es wird keine Dauer angenommen.")).toBeInTheDocument();
    expect(editor.getByLabelText("Ende")).toHaveValue("");
  });

  it("supports a date-only availability value and keeps the API pair coherent", async () => {
    renderPage();
    const editor = await openWorkPropertyEditor("Rückmeldezettel abgeben", "+ Ab");
    const date = editor.getByRole("textbox", { name: "Ab" });
    fireEvent.change(date, { target: { value: "12.10.2026" } });
    fireEvent.blur(date);
    closeEditor(editor);
    fireEvent.click(applyButton());
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalled());
    const availability = mockedApi.applyIntake.mock.calls[0]?.[1].draft?.workItems[0];
    expect(availability?.notBeforeDate).toBe("2026-10-12");
    expect(availability?.notBeforeAt).toBeTruthy();
    expect(new Date(availability!.notBeforeAt!).getHours()).toBe(0);
  });

  it("changes a timed availability date and clears both date and time fields", async () => {
    renderPage();
    const editor = await openWorkPropertyEditor("Rückmeldezettel abgeben", "+ Ab");
    const date = editor.getByRole("textbox", { name: "Ab" });
    fireEvent.change(date, { target: { value: "12.10.2026" } });
    fireEvent.blur(date);
    fireEvent.click(editor.getByRole("checkbox", { name: "Uhrzeit" }));
    fireEvent.change(editor.getByDisplayValue("08:00"), { target: { value: "17:30" } });
    fireEvent.change(date, { target: { value: "13.10.2026" } });
    fireEvent.blur(date);
    expect(date).toHaveValue("13.10.2026");
    expect(editor.getByDisplayValue("17:30")).toBeInTheDocument();
    fireEvent.change(date, { target: { value: "" } });
    fireEvent.blur(date);
    expect(date).toHaveValue("");
    expect(editor.getByRole("checkbox", { name: "Uhrzeit" })).toBeDisabled();
    closeEditor(editor);
    fireEvent.click(applyButton());
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
    await waitFor(() => expect(mockedApi.retryIntake).toHaveBeenCalledWith("i1", undefined));
  });

  it("accepts leased analyzing and replacement ready states while polling after retry", async () => {
    const conflictedDraft = {
      ...draft,
      workItems: [{
        ...draft.workItems[0]!,
        needsClarification: true,
        reminders: [{ kind: "absolute" as const, at: "2026-10-01T08:00:00+02:00" }],
      }, draft.workItems[1]!],
    };
    const replacementDraft = {
      ...draft,
      summary: "Ersetzte Analyse",
    };
    mockedApi.getIntake
      .mockResolvedValueOnce({ ...record(), revision: 2, draft: conflictedDraft } as never)
      .mockResolvedValueOnce({ ...record("analyzing"), revision: 3, draft: null } as never)
      .mockResolvedValueOnce({ ...record(), revision: 4, draft: replacementDraft } as never);
    mockedApi.retryIntake.mockResolvedValueOnce({ ...record("queued"), revision: 3, draft: null } as never);
    vi.useFakeTimers();
    renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "Elternabend" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erneut analysieren" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedApi.retryIntake).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("Der Inhalt wird analysiert …")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("Ersetzte Analyse")).toBeInTheDocument();
  });

  it("accepts an analysis failure delivered by polling", async () => {
    mockedApi.getIntake
      .mockResolvedValueOnce({ ...record("queued"), revision: 1, draft: null } as never)
      .mockResolvedValueOnce({
        ...record("analysis_failed", {
          code: "ai_task_failed",
          message: "Analyse fehlgeschlagen",
          retryable: true,
        }),
        revision: 2,
        draft: null,
      } as never);
    vi.useFakeTimers();
    renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Die Verarbeitung wartet auf Home Assistant.")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("Analyse fehlgeschlagen")).toBeInTheDocument();
  });

  it.each([
    ["applied", "Verarbeitung übernommen"],
    ["partially_applied", "Teilweise übernommen"],
  ])("accepts %s delivered by polling", async (status, text) => {
    mockedApi.getIntake
      .mockResolvedValueOnce({ ...record("applying"), revision: 5, draft: null } as never)
      .mockResolvedValueOnce({ ...record(status), revision: 6, draft: null } as never);
    vi.useFakeTimers();
    renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Wird übernommen …")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("accepts a lease-derived analyzing state without a revision increment", async () => {
    mockedApi.getIntake
      .mockResolvedValueOnce({ ...record("queued"), revision: 3, draft: null } as never)
      .mockResolvedValueOnce({ ...record("analyzing"), revision: 3, draft: null } as never);
    vi.useFakeTimers();
    renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Die Verarbeitung wartet auf Home Assistant.")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("Der Inhalt wird analysiert …")).toBeInTheDocument();
  });

  it("ignores a delayed pre-retry response after the queued replacement is accepted", async () => {
    const conflictedDraft = {
      ...draft,
      workItems: [{
        ...draft.workItems[0]!,
        needsClarification: true,
        reminders: [{ kind: "absolute" as const, at: "2026-10-01T08:00:00+02:00" }],
      }, draft.workItems[1]!],
    };
    let resolveStale!: (value: ReturnType<typeof record>) => void;
    const staleResponse = new Promise<ReturnType<typeof record>>((resolve) => {
      resolveStale = resolve;
    });
    mockedApi.getIntake
      .mockResolvedValueOnce({ ...record(), revision: 2, draft: conflictedDraft } as never)
      .mockReturnValueOnce(staleResponse as never);
    mockedApi.retryIntake.mockResolvedValueOnce({ ...record("queued"), revision: 3, draft: null } as never);
    renderPage();
    await screen.findByRole("heading", { name: "Elternabend" });
    vi.useFakeTimers();
    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    fireEvent.click(screen.getByRole("button", { name: "Erneut analysieren" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Die Verarbeitung wartet auf Home Assistant.")).toBeInTheDocument();
    await act(async () => {
      resolveStale({ ...record(), revision: 2, draft: conflictedDraft });
      await Promise.resolve();
    });
    expect(screen.getByText("Die Verarbeitung wartet auf Home Assistant.")).toBeInTheDocument();
  });

  it("ignores a delayed pre-Apply response after applying starts", async () => {
    let resolveStale!: (value: ReturnType<typeof record>) => void;
    const staleResponse = new Promise<ReturnType<typeof record>>((resolve) => {
      resolveStale = resolve;
    });
    mockedApi.getIntake
      .mockResolvedValueOnce({ ...record(), revision: 2 } as never)
      .mockReturnValueOnce(staleResponse as never);
    mockedApi.applyIntake.mockResolvedValueOnce({ ...record("applying"), revision: 3, draft: null } as never);
    renderPage();
    await screen.findByRole("heading", { name: "Elternabend" });
    vi.useFakeTimers();
    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    fireEvent.click(applyButton());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Wird übernommen …")).toBeInTheDocument();
    await act(async () => {
      resolveStale({ ...record(), revision: 2 });
      await Promise.resolve();
    });
    expect(screen.getByText("Wird übernommen …")).toBeInTheDocument();
  });

  it("saves an immediate edit before reanalysis and replaces the completed proposal", async () => {
    const conflictedDraft = {
      ...draft,
      workItems: [{
        ...draft.workItems[0]!,
        needsClarification: true,
        reminders: [{ kind: "absolute" as const, at: "2026-10-01T08:00:00+02:00" }],
      }, { ...draft.workItems[1]!, parentKey: null }],
    };
    const replacementDraft = {
      ...draft,
      workItems: [{ ...draft.workItems[0]!, title: "Ersetzter Vorschlag" }, draft.workItems[1]!],
    };
    mockedApi.getIntake.mockResolvedValueOnce({
      ...record(),
      draft: conflictedDraft,
    } as never);
    mockedApi.retryIntake.mockResolvedValueOnce({
      ...record(),
      draft: replacementDraft,
    } as never);
    renderPage();
    const editor = await openEditor("Rückmeldezettel abgeben");
    await changeTitle(editor, "Geänderte Auswahl");
    closeEditor(editor);
    fireEvent.click(screen.getByRole("button", { name: "Erneut analysieren" }));
    await waitFor(() => expect(mockedApi.updateIntakeDraft).toHaveBeenCalled());
    await waitFor(() => expect(mockedApi.retryIntake).toHaveBeenCalledWith("i1", undefined));
    expect(mockedApi.updateIntakeDraft.mock.invocationCallOrder[0]).toBeLessThan(
      mockedApi.retryIntake.mock.invocationCallOrder[0]!,
    );
    expect(mockedApi.updateIntakeDraft.mock.calls[0]?.[1].draft.workItems[0]?.title)
      .toBe("Geänderte Auswahl");
    expect(await screen.findByRole("heading", { name: "Ersetzter Vorschlag" })).toBeInTheDocument();
  });

  it("loads and submits a changed ready-proposal retry hint", async () => {
    const conflictedDraft = {
      ...draft,
      workItems: [{
        ...draft.workItems[0]!,
        needsClarification: true,
        reminders: [{ kind: "absolute" as const, at: "2026-10-01T08:00:00+02:00" }],
      }, { ...draft.workItems[1]!, parentKey: null }],
    };
    mockedApi.getIntake.mockResolvedValue({
      ...record(),
      retryHint: "Gespeicherter Hinweis",
      draft: conflictedDraft,
    } as never);
    mockedApi.retryIntake.mockResolvedValue(record("queued") as never);
    renderPage();
    const hintLabel = await screen.findByText("Hinweis für den nächsten Versuch");
    const hint = within(hintLabel.closest("label")!).getByRole("textbox");
    expect(hint).toHaveValue("Gespeicherter Hinweis");
    fireEvent.change(hint, { target: { value: "Bitte den Titel übernehmen." } });
    fireEvent.click(screen.getByRole("button", { name: "Erneut analysieren" }));
    await waitFor(() => expect(mockedApi.retryIntake).toHaveBeenCalledWith("i1", "Bitte den Titel übernehmen."));
  });

  it("unblocks Apply when a conflicting proposal is deselected", async () => {
    const conflictedDraft = {
      ...draft,
      workItems: [{
        ...draft.workItems[0]!,
        enabled: false,
        needsClarification: true,
        reminders: [{ kind: "absolute" as const, at: "2026-10-01T08:00:00+02:00" }],
      }, { ...draft.workItems[1]!, parentKey: null }],
    };
    mockedApi.getIntake.mockResolvedValue({
      ...record(),
      draft: conflictedDraft,
    } as never);
    renderPage();
    await screen.findByRole("heading", { name: "Kalender" });
    expect(applyButton()).not.toBeDisabled();
    fireEvent.click(applyButton());
    await waitFor(() => expect(mockedApi.applyIntake).toHaveBeenCalledTimes(1));
    expect(mockedApi.applyIntake.mock.calls[0]?.[1].draft?.workItems[0]).toMatchObject({
      enabled: false,
      title: "Rückmeldezettel abgeben",
    });
    expect(mockedApi.applyIntake.mock.calls[0]?.[1].draft?.workItems[1]?.enabled).toBe(true);
  });

  it("ignores invalid date input on a disabled card until it is re-enabled and corrected", async () => {
    renderPage();
    const editor = await openWorkPropertyEditor("Rückmeldezettel abgeben", "Fällig: 02.10.2026");
    const date = editor.getByRole("textbox", { name: "Fällig" });
    fireEvent.change(date, { target: { value: "kein Datum" } });
    fireEvent.blur(date);
    expect(screen.getByText("Datum nicht erkannt")).toBeInTheDocument();
    const checkbox = screen.getByRole("checkbox", {
      name: "In Vorschlag übernehmen: Rückmeldezettel abgeben",
    });
    fireEvent.click(checkbox);
    expect(applyButton()).not.toBeDisabled();
    fireEvent.click(checkbox);
    expect(applyButton()).toBeDisabled();
    const correctedDate = editor.getByRole("textbox", { name: "Fällig" });
    fireEvent.change(correctedDate, { target: { value: "03.10.2026" } });
    fireEvent.blur(correctedDate);
    closeEditor(editor);
    expect(applyButton()).not.toBeDisabled();
  });

  it("clears a ready-proposal retry hint explicitly", async () => {
    const conflictedDraft = {
      ...draft,
      workItems: [{
        ...draft.workItems[0]!,
        needsClarification: true,
        reminders: [{ kind: "absolute" as const, at: "2026-10-01T08:00:00+02:00" }],
      }, draft.workItems[1]!],
    };
    mockedApi.getIntake.mockResolvedValue({
      ...record(),
      retryHint: "Gespeicherter Hinweis",
      draft: conflictedDraft,
    } as never);
    mockedApi.retryIntake.mockResolvedValue(record("queued") as never);
    renderPage();
    const hintLabel = await screen.findByText("Hinweis für den nächsten Versuch");
    const hint = within(hintLabel.closest("label")!).getByRole("textbox");
    fireEvent.change(hint, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Erneut analysieren" }));
    await waitFor(() => expect(mockedApi.retryIntake).toHaveBeenCalledWith("i1", ""));
  });

  it("clears a persisted retry hint when the field is emptied", async () => {
    mockedApi.getIntake.mockResolvedValue({
      ...record("analysis_failed", {
        code: "ai_task_failed", message: "Analyse fehlgeschlagen", retryable: true,
      }),
      retryHint: "Bitte keine Erinnerung ergänzen.",
    } as never);
    mockedApi.retryIntake.mockResolvedValue({
      ...record("queued"),
      retryHint: null,
    } as never);
    renderPage();
    const hintLabel = await screen.findByText("Hinweis für den nächsten Versuch");
    const hint = within(hintLabel.closest("label")!).getByRole("textbox");
    expect(hint).toHaveValue("Bitte keine Erinnerung ergänzen.");
    fireEvent.change(hint, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Erneut analysieren" }));
    await waitFor(() => expect(mockedApi.retryIntake).toHaveBeenCalledWith("i1", ""));
    expect((await mockedApi.retryIntake.mock.results[0]?.value)?.retryHint).toBeNull();
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
