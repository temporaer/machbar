import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { WaitingGroupList } from "./WaitingGroupList";
import { api } from "../lib/api";
import { makeMember, makeTask, makeWaitingGroup } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    updateTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

describe("WaitingGroupList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem("machbar:identity-member-id", "1");
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.updateTask.mockResolvedValue(makeTask());
  });

  it("gruppiert Aufgaben nach Wartet-auf und markiert sie wieder machbar", async () => {
    const task = makeTask({ id: 7, title: "Rückmeldung abwarten", status: "waiting" });
    const group = makeWaitingGroup({ waitingFor: "Steuerberater", tasks: [task] });
    renderWithProviders(<WaitingGroupList groups={[group]} />);

    expect(await screen.findByText(/Steuerberater/)).toBeInTheDocument();
    expect(screen.getByText("Rückmeldung abwarten")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Wieder machbar" }));

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith(7, { status: "actionable" }));
  });

  it("zeigt einen leeren Zustand ohne Gruppen", () => {
    renderWithProviders(<WaitingGroupList groups={[]} />);
    expect(screen.getByText("Nichts wartet gerade.")).toBeInTheDocument();
  });

  it("öffnet ein fokussiertes Nachhaken-Popup mit Zeitstempel und Benutzer", async () => {
    const task = makeTask({
      id: 8,
      title: "Angebot nachfragen",
      notes: "Erste Anfrage versendet.",
      status: "waiting",
    });
    renderWithProviders(
      <WaitingGroupList
        groups={[makeWaitingGroup({ waitingFor: "Handwerker", tasks: [task] })]}
      />,
    );
    await screen.findByText("Angebot nachfragen");

    await userEvent.click(screen.getByRole("button", { name: "Nachhaken" }));

    const notes = (await screen.findByLabelText("Notizen")) as HTMLTextAreaElement;
    expect(notes.value).toContain("Erste Anfrage versendet.");
    expect(notes.value).toContain("· Mira]");
    expect(screen.queryByLabelText("Titel")).not.toBeInTheDocument();
  });

  it("speichert Notiz, Wiedervorlage und optional den bearbeitbaren Status", async () => {
    const task = makeTask({ id: 9, title: "Rückruf nachhalten", status: "waiting" });
    renderWithProviders(
      <WaitingGroupList
        groups={[makeWaitingGroup({ waitingFor: "Praxis", tasks: [task] })]}
      />,
    );
    await screen.findByText("Rückruf nachhalten");
    await userEvent.click(screen.getByRole("button", { name: "Nachhaken" }));

    const notes = await screen.findByLabelText("Notizen");
    await userEvent.type(notes, "Erneut angerufen.");
    await userEvent.type(screen.getByLabelText("Neue Wiedervorlage"), "2026-09-05");
    await userEvent.click(screen.getByRole("checkbox", { name: "Wieder machbar" }));
    await userEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));

    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith(9, {
        notes: expect.stringContaining("Erneut angerufen."),
        scheduledDate: "2026-09-05",
        status: "actionable",
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
