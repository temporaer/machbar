import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { WaitingGroupList } from "./WaitingGroupList";
import { api } from "../lib/api";
import { makeMember, makeTag, makeTask, makeWaitingGroup } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    getTask: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
    reorderTask: vi.fn(),
    indentTask: vi.fn(),
    outdentTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("WaitingGroupList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.localStorage.setItem("machbar:identity-member-id", "1");
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.updateTask.mockResolvedValue(makeTask());
  });

  it("flacht Gruppen zu einer einzigen Aufgabenliste ohne externe Gruppenüberschriften ab", async () => {
    const taskA = makeTask({ id: 101, title: "Erste Aufgabe", status: "waiting", waitingFor: "Steuerberater" });
    const taskB = makeTask({ id: 102, title: "Zweite Aufgabe", status: "waiting", waitingFor: null });
    const groupA = makeWaitingGroup({ waitingFor: "Steuerberater", tasks: [taskA] });
    const groupB = makeWaitingGroup({ waitingFor: "Unbekannt", tasks: [taskB] });

    const { container } = renderWithProviders(<WaitingGroupList groups={[groupA, groupB]} />);

    await screen.findByText("Erste Aufgabe");
    expect(screen.getByText("Zweite Aufgabe")).toBeInTheDocument();

    // No bespoke group-header wrapper — only standard TaskOutline rows.
    expect(container.querySelectorAll(".section-title").length).toBe(0);
    expect(container.querySelectorAll(".section").length).toBe(0);
    expect(container.querySelectorAll(".task-row").length).toBe(2);
  });

  it("zeigt group.waitingFor als Anzeige-Fallback, wenn task.waitingFor leer ist, ohne die Aufgabe zu verändern", async () => {
    const task = makeTask({ id: 103, title: "Ohne eigenes Wartet-auf", status: "waiting", waitingFor: null });
    const group = makeWaitingGroup({ waitingFor: "Unbekannt", tasks: [task] });

    renderWithProviders(<WaitingGroupList groups={[group]} />);

    await screen.findByText("Ohne eigenes Wartet-auf");
    expect(screen.getByText("Wartet auf: Unbekannt")).toBeInTheDocument();

    // Purely a display fallback — the source task object stays untouched
    // and nothing is sent to the API just from rendering.
    expect(task.waitingFor).toBeNull();
    expect(mockedApi.updateTask).not.toHaveBeenCalled();
  });

  it("respektiert die Reihenfolge aus dem Backend (Gruppen dann Aufgaben) ohne Duplikate", async () => {
    const first = makeTask({ id: 111, title: "A - erste", status: "waiting", waitingFor: "Steuerberater" });
    const second = makeTask({ id: 112, title: "B - zweite", status: "waiting", waitingFor: null });
    const third = makeTask({ id: 113, title: "C - dritte", status: "waiting", waitingFor: null });
    const groupA = makeWaitingGroup({ waitingFor: "Steuerberater", tasks: [first] });
    const groupB = makeWaitingGroup({ waitingFor: "Unbekannt", tasks: [second, third] });

    const { container } = renderWithProviders(<WaitingGroupList groups={[groupA, groupB]} />);
    await screen.findByText("A - erste");

    const titles = [...container.querySelectorAll(".task-row-title")].map((el) => el.textContent);
    expect(titles).toEqual(["A - erste", "B - zweite", "C - dritte"]);
    expect(container.querySelectorAll(".task-row").length).toBe(3);
  });

  it("gruppiert nach einem Tag-Typ, ohne mehrfach getaggte Aufgaben zu duplizieren", async () => {
    const phone = makeTag({ id: 201, name: "Telefon", kind: "context" });
    const home = makeTag({ id: 202, name: "Zuhause", kind: "context" });
    const tagged = makeTask({
      id: 203,
      title: "Mehrfach getaggt",
      status: "waiting",
      effectiveTags: [phone, home],
    });
    const untagged = makeTask({ id: 204, title: "Ohne Tag", status: "waiting" });
    const group = makeWaitingGroup({ tasks: [tagged, untagged] });

    const { container } = renderWithProviders(
      <WaitingGroupList groups={[group]} groupBy="context" />,
    );

    await screen.findByText("Mehrfach getaggt");
    expect(screen.getByRole("heading", { name: "Telefon" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ohne Kontext" })).toBeInTheDocument();
    expect(container.querySelectorAll(".task-row").length).toBe(2);
  });

  it("zeigt einen leeren Zustand ohne Gruppen", async () => {
    renderWithProviders(<WaitingGroupList groups={[]} />);
    // `findByText` (unlike `getByText`) waits under `act()`, flushing
    // `IdentityProvider`'s pending member fetch before the test ends — the
    // synchronous `getByText` left that resolution to leak past the test.
    expect(await screen.findByText("Nichts wartet gerade.")).toBeInTheDocument();
  });

  it("markiert eine wartende Aufgabe per Rechts-Swipe wieder machbar", async () => {
    const task = makeTask({ id: 121, title: "Rückmeldung abwarten", status: "waiting" });
    mockedApi.updateTask.mockResolvedValue({ ...task, status: "actionable" });
    const group = makeWaitingGroup({ waitingFor: "Steuerberater", tasks: [task] });

    const { container } = renderWithProviders(<WaitingGroupList groups={[group]} />);
    await screen.findByText("Rückmeldung abwarten");

    const content = container.querySelector(".task-row-content") as HTMLElement;
    fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(content, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(content, { clientX: 100, pointerId: 1 });

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(121, { status: "actionable" }));
  });

  it("öffnet über den Nachhaken-Chip das Follow-up-Popup und schließt es nach dem Speichern", async () => {
    const task = makeTask({
      id: 131,
      title: "Angebot nachfragen",
      notes: "Erste Anfrage versendet.",
      status: "waiting",
    });
    const group = makeWaitingGroup({ waitingFor: "Handwerker", tasks: [task] });
    renderWithProviders(<WaitingGroupList groups={[group]} />);
    await screen.findByText("Angebot nachfragen");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    const chips = screen.getByRole("group", { name: "Weitere Aktionen" });
    await userEvent.click(within(chips).getByRole("button", { name: "Nachhaken" }));

    const notes = (await screen.findByLabelText("Notizen")) as HTMLTextAreaElement;
    expect(notes.value).toContain("Erste Anfrage versendet.");
    expect(notes.value).toContain("· Mira]");

    await userEvent.type(notes, "Erneut angerufen.");
    await userEvent.type(screen.getByLabelText("Neue Wiedervorlage"), "2026-09-05");
    await userEvent.click(screen.getByRole("checkbox", { name: "Wieder machbar" }));
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(131, {
        notes: expect.stringContaining("Erneut angerufen."),
        scheduledDate: "2026-09-05",
        status: "actionable",
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
