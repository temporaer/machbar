import { useEffect } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/testUtils";
import { useRefresh } from "../lib/refresh";
import { TaskOutline } from "./TaskOutline";
import { api } from "../lib/api";
import { makeMember, makeTask } from "../test/fixtures";

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
    createChildTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

/** Records every distinct `version` the shared `RefreshProvider` produces, in order. */
function VersionLog({ log }: { log: number[] }) {
  const { version } = useRefresh();
  useEffect(() => {
    log.push(version);
  }, [log, version]);
  return null;
}

async function openChipsFor(taskTitle: string) {
  const row = (await screen.findByText(taskTitle)).closest(".task-row") as HTMLElement;
  await userEvent.click(
    Array.from(row.querySelectorAll("button")).find((b) => b.className.includes("task-row-kebab"))!,
  );
  return row;
}

describe("TaskRow – inline child (subtask) composer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  it("opens a small inline composer beneath the task from the chip strip, not a full sheet", async () => {
    const task = makeTask({ id: 200, title: "Umzug organisieren", status: "actionable" });
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await openChipsFor("Umzug organisieren");

    const addChildButton = screen.getByRole("button", { name: "Teilaufgabe hinzufügen" });
    expect(addChildButton).toHaveAttribute("title", "Teilaufgabe hinzufügen");
    await userEvent.click(addChildButton);

    // Composer is inline, not the full detail sheet.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Titel")).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText("Neue Teilaufgabe");
    expect(input).toBeInTheDocument();
    // Opening the composer also closes the chip strip itself.
    expect(screen.queryByRole("button", { name: "Zuweisen" })).not.toBeInTheDocument();
  });

  it("creates the child via api.createChildTask with the title and sensible defaults, bumps refresh, closes the composer, and returns focus to the task row's kebab button", async () => {
    const parent = makeTask({ id: 201, title: "Konferenz vorbereiten", status: "actionable" });
    mockedApi.createChildTask.mockResolvedValue(makeTask({ id: 9001, title: "Redner einladen", parentTaskId: 201 }));
    const versions: number[] = [];
    renderWithProviders(
      <div>
        <VersionLog log={versions} />
        <TaskOutline tasks={[parent]} emptyMessage="Nichts da" />
      </div>,
    );
    await openChipsFor("Konferenz vorbereiten");
    await userEvent.click(screen.getByRole("button", { name: "Teilaufgabe hinzufügen" }));

    const input = screen.getByPlaceholderText("Neue Teilaufgabe");
    await userEvent.type(input, "Redner einladen");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.createChildTask).toHaveBeenCalledWith(201, {
        title: "Redner einladen",
        createdByMemberId: null,
        status: "actionable",
      }),
    );

    // Composer closes on success.
    await waitFor(() => expect(screen.queryByPlaceholderText("Neue Teilaufgabe")).not.toBeInTheDocument());
    // Refresh bus was bumped at least once beyond the initial mount value.
    await waitFor(() => expect(versions.length).toBeGreaterThan(1));
    // Focus returns to the task row's kebab button (task vicinity), since the add-child chip itself unmounts once the chip strip closes.
    await waitFor(() => expect(screen.getByRole("button", { name: "Weitere Aktionen" })).toHaveFocus());
  });

  it("expands a collapsed parent automatically once its new child is created", async () => {
    const child = makeTask({ id: 300, title: "Bestehende Teilaufgabe", status: "actionable" });
    const parent = makeTask({ id: 301, title: "Projekt starten", status: "actionable", children: [child] });
    mockedApi.createChildTask.mockResolvedValue(makeTask({ id: 302, title: "Neue Teilaufgabe X", parentTaskId: 301 }));
    renderWithProviders(<TaskOutline tasks={[parent]} emptyMessage="Nichts da" />);
    await screen.findByText("Projekt starten");
    expect(screen.getByText("Bestehende Teilaufgabe")).toBeInTheDocument();

    // Collapse the parent first.
    await userEvent.click(screen.getByRole("button", { name: "Einklappen" }));
    expect(screen.queryByText("Bestehende Teilaufgabe")).not.toBeInTheDocument();

    await openChipsFor("Projekt starten");
    await userEvent.click(screen.getByRole("button", { name: "Teilaufgabe hinzufügen" }));
    await userEvent.type(screen.getByPlaceholderText("Neue Teilaufgabe"), "Neue Teilaufgabe X");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(mockedApi.createChildTask).toHaveBeenCalled());
    // Collapsed state was local to this row — success must flip it back open.
    await waitFor(() => expect(screen.getByText("Bestehende Teilaufgabe")).toBeInTheDocument());
  });

  it("supports adding a child to a nested (non-root) task", async () => {
    const grandchild = makeTask({ id: 400, title: "Enkel-Aufgabe", status: "actionable" });
    const child = makeTask({ id: 401, title: "Kind-Aufgabe", status: "actionable", children: [] });
    const parent = makeTask({ id: 402, title: "Wurzel-Aufgabe", status: "actionable", children: [child] });
    mockedApi.createChildTask.mockResolvedValue(grandchild);
    renderWithProviders(<TaskOutline tasks={[parent]} emptyMessage="Nichts da" />);
    await screen.findByText("Kind-Aufgabe");

    await openChipsFor("Kind-Aufgabe");
    await userEvent.click(screen.getByRole("button", { name: "Teilaufgabe hinzufügen" }));
    await userEvent.type(screen.getByPlaceholderText("Neue Teilaufgabe"), "Enkel-Aufgabe");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() =>
      expect(mockedApi.createChildTask).toHaveBeenCalledWith(401, {
        title: "Enkel-Aufgabe",
        createdByMemberId: null,
        status: "actionable",
      }),
    );
  });

  it("cancels without ever calling the API and returns focus to the task row's kebab button", async () => {
    const task = makeTask({ id: 500, title: "Steuererklärung", status: "actionable" });
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await openChipsFor("Steuererklärung");
    await userEvent.click(screen.getByRole("button", { name: "Teilaufgabe hinzufügen" }));

    await userEvent.type(screen.getByPlaceholderText("Neue Teilaufgabe"), "Sollte verworfen werden");
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));

    expect(mockedApi.createChildTask).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("Neue Teilaufgabe")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Weitere Aktionen" })).toHaveFocus());
  });

  it("keeps the composer open with a visible error and the typed title when the API call fails", async () => {
    const task = makeTask({ id: 600, title: "Reisekosten abrechnen", status: "actionable" });
    mockedApi.createChildTask.mockRejectedValue(new Error("Netzwerkfehler"));
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await openChipsFor("Reisekosten abrechnen");
    await userEvent.click(screen.getByRole("button", { name: "Teilaufgabe hinzufügen" }));

    const input = screen.getByPlaceholderText("Neue Teilaufgabe");
    await userEvent.type(input, "Belege sammeln");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Netzwerkfehler");
    // Composer stays open with the title retained, nothing was lost.
    expect(screen.getByPlaceholderText("Neue Teilaufgabe")).toHaveValue("Belege sammeln");
  });

  it("prevents a duplicate submit while a create request is still in flight", async () => {
    const task = makeTask({ id: 700, title: "Werkstatt anrufen", status: "actionable" });
    let resolveCreate!: (value: ReturnType<typeof makeTask>) => void;
    mockedApi.createChildTask.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await openChipsFor("Werkstatt anrufen");
    await userEvent.click(screen.getByRole("button", { name: "Teilaufgabe hinzufügen" }));

    await userEvent.type(screen.getByPlaceholderText("Neue Teilaufgabe"), "Termin klären");
    const saveButton = screen.getByRole("button", { name: "Speichern" });
    await userEvent.click(saveButton);
    // Busy: the save button is disabled once a request is in flight, so a
    // second click can't fire a second request.
    expect(saveButton).toBeDisabled();
    await userEvent.click(saveButton);

    expect(mockedApi.createChildTask).toHaveBeenCalledTimes(1);
    resolveCreate(makeTask({ id: 9002, title: "Termin klären", parentTaskId: 700 }));
    await waitFor(() => expect(screen.queryByPlaceholderText("Neue Teilaufgabe")).not.toBeInTheDocument());
  });

  it("returns focus into the row even when the kebab button is disabled by an in-flight mutation", async () => {
    const task = makeTask({ id: 850, title: "Anhänger mieten", status: "actionable" });
    let resolveComplete!: (value: ReturnType<typeof makeTask>) => void;
    mockedApi.completeTask.mockReturnValue(
      new Promise((resolve) => {
        resolveComplete = resolve;
      }),
    );
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await openChipsFor("Anhänger mieten");
    await userEvent.click(screen.getByRole("button", { name: "Teilaufgabe hinzufügen" }));
    expect(screen.getByPlaceholderText("Neue Teilaufgabe")).toBeInTheDocument();

    // A status mutation starts while the composer is open, disabling the
    // kebab the composer would normally hand focus back to.
    await userEvent.click(screen.getByRole("button", { name: "Erledigt" }));
    expect(screen.getByRole("button", { name: "Weitere Aktionen" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));

    expect(mockedApi.createChildTask).not.toHaveBeenCalled();
    // Focus must not fall through to <body>; it stays inside the task row.
    expect(document.activeElement).not.toBe(document.body);
    expect((await screen.findByText("Anhänger mieten")).closest(".task-row")).toContainElement(
      document.activeElement as HTMLElement,
    );

    await act(async () => {
      resolveComplete(makeTask({ ...task, status: "done" }));
      await Promise.resolve();
    });
  });

  it("disables the add-child chip while the task itself has a mutation in flight", async () => {
    const task = makeTask({ id: 800, title: "Vertrag unterschreiben", status: "actionable" });
    let resolveComplete!: (value: ReturnType<typeof makeTask>) => void;
    mockedApi.completeTask.mockReturnValue(
      new Promise((resolve) => {
        resolveComplete = resolve;
      }),
    );
    renderWithProviders(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await openChipsFor("Vertrag unterschreiben");
    const addChildButton = screen.getByRole("button", { name: "Teilaufgabe hinzufügen" });
    expect(addChildButton).toBeEnabled();

    // Trigger a busy mutation via the checkbox while the chip strip is
    // already open — the add-child chip must reflect the row's busy state.
    await userEvent.click(screen.getByRole("button", { name: "Erledigt" }));

    expect(addChildButton).toBeDisabled();

    await act(async () => {
      resolveComplete(makeTask({ ...task, status: "done" }));
      await Promise.resolve();
    });
  });
});
