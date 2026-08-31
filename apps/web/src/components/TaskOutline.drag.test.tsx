import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task } from "@machbar/shared";
import { renderWithProviders } from "../test/testUtils";
import { TaskOutline } from "./TaskOutline";
import { api } from "../lib/api";
import { useRefresh } from "../lib/refresh";
import { useTaskDetail } from "../lib/taskDetailContext";
import { makeMember, makeTask } from "../test/fixtures";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getTags: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

const ROW_HEIGHT = 40;

function RefreshVersion() {
  const { version } = useRefresh();
  return <output data-testid="refresh-version">{version}</output>;
}

/** Flushes the microtask queue (mutation `await`s) without depending on real timers. */
async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

/**
 * jsdom has no layout, so the drag projection would see zero-sized rows.
 * Every rendered row therefore gets a synthetic rect: uniform height,
 * stacked top to bottom in document order — exactly the geometry the real
 * outline has.
 */
function stubRowGeometry() {
  const contents = [...document.querySelectorAll<HTMLElement>(".task-row-content")];
  contents.forEach((element, i) => {
    element.getBoundingClientRect = () =>
      ({ top: i * ROW_HEIGHT, bottom: (i + 1) * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 300, width: 300, x: 0, y: i * ROW_HEIGHT, toJSON: () => ({}) }) as DOMRect;
  });
  const outline = document.querySelector<HTMLElement>(".task-outline");
  if (outline) {
    outline.getBoundingClientRect = () =>
      ({ top: 0, bottom: contents.length * ROW_HEIGHT, height: contents.length * ROW_HEIGHT, left: 0, right: 300, width: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  }
  return contents;
}

function handleFor(title: string): HTMLElement {
  return screen.getByRole("button", { name: `Verschieben: ${title}` });
}

/** Vertical centre of the row at `rowIndex`, optionally nudged by `offsetY`. */
function centreOf(rowIndex: number, offsetY = 0): number {
  return rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2 + offsetY;
}

interface DragOptions {
  toY: number;
  offsetX?: number;
  /** Release (commit) instead of cancelling. Defaults to true. */
  drop?: boolean;
  cancel?: boolean;
}

function drag(title: string, { toY, offsetX = 0, drop = true, cancel = false }: DragOptions) {
  stubRowGeometry();
  const handle = handleFor(title);
  fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: offsetX, clientY: toY, pointerId: 1 });
  if (cancel) fireEvent.pointerCancel(window, { pointerId: 1 });
  else if (drop) fireEvent.pointerUp(window, { pointerId: 1 });
}

/** Reports the detail sheet the context would have opened, without rendering it. */
function OpenProbe() {
  const { openTaskId } = useTaskDetail();
  return <output data-testid="offene-details">{openTaskId ?? "keine"}</output>;
}

function outlineTasks(): Task[] {
  const a = makeTask({ id: 1, title: "Alpha", position: 0, projectId: 5 });
  const b = makeTask({ id: 2, title: "Beta", position: 1, projectId: 5 });
  const c = makeTask({ id: 3, title: "Gamma", position: 2, projectId: 5 });
  return [a, b, c];
}

function renderedOrder(): string[] {
  return [...document.querySelectorAll(".task-row-title")].map((el) => el.textContent ?? "");
}

describe("TaskOutline Ziehen und Umbauen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sortiert Geschwister durch senkrechtes Ziehen um", async () => {
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 1 }));
    renderWithProviders(<TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />);
    await screen.findByText("Alpha");

    // Alpha bis unter Gamma ziehen.
    drag("Alpha", { toY: centreOf(2, 5) });

    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenCalledWith(1, {
        parentTaskId: null,
        projectId: 5,
        position: 2,
        expectedRevision: 1,
      }),
    );
    // Die Liste zeigt das Ergebnis sofort, ohne auf einen Refresh zu warten.
    expect(renderedOrder()).toEqual(["Beta", "Gamma", "Alpha"]);
  });

  it("ignoriert eine ältere überlappende Aktualisierung nach einem erfolgreichen Zug", async () => {
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 1, revision: 2 }));
    const rendered = renderWithProviders(
      <TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />,
    );
    await screen.findByText("Alpha");

    drag("Alpha", { toY: centreOf(2, 5) });
    await waitFor(() => expect(mockedApi.moveTask).toHaveBeenCalledTimes(1));
    expect(renderedOrder()).toEqual(["Beta", "Gamma", "Alpha"]);

    // A request started before the move may still return a new array carrying
    // the old revision and order. It must not replace the accepted override.
    rendered.rerender(
      <TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />,
    );
    expect(renderedOrder()).toEqual(["Beta", "Gamma", "Alpha"]);

    drag("Alpha", { toY: -10 });
    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenLastCalledWith(1, {
        parentTaskId: null,
        projectId: 5,
        position: 0,
        expectedRevision: 2,
      }),
    );
  });

  it("rückt beim Ziehen nach rechts unter die vorangehende Aufgabe ein", async () => {
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 2 }));
    renderWithProviders(<TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />);
    await screen.findByText("Beta");

    // Beta an seinem Platz lassen, aber eine Stufe nach rechts.
    drag("Beta", { toY: centreOf(1, -5), offsetX: 32 });

    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenCalledWith(2, {
        parentTaskId: 1,
        position: 0,
        expectedRevision: 1,
      }),
    );
    // Beta hängt jetzt unter Alpha.
    expect(document.querySelectorAll(".task-row-children .task-row-title")[0]?.textContent).toBe("Beta");
  });

  it("rückt beim Ziehen nach links wieder eine Stufe aus", async () => {
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 3 }));
    const child = makeTask({ id: 3, title: "Gamma", parentTaskId: 2, position: 0, projectId: 5 });
    const tasks = [
      makeTask({ id: 1, title: "Alpha", position: 0, projectId: 5 }),
      makeTask({ id: 2, title: "Beta", position: 1, projectId: 5, children: [child] }),
    ];
    renderWithProviders(<TaskOutline tasks={tasks} emptyMessage="Nichts da" organizable />);
    await screen.findByText("Gamma");

    drag("Gamma", { toY: centreOf(2, 5), offsetX: -32 });

    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenCalledWith(3, {
        parentTaskId: null,
        projectId: 5,
        position: 2,
        expectedRevision: 1,
      }),
    );
    expect(renderedOrder()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(document.querySelectorAll(".task-row-children").length).toBe(0);
  });

  it("stellt die Reihenfolge wieder her und meldet einen abgelehnten Zug an der Zeile", async () => {
    mockedApi.moveTask.mockRejectedValue(new Error("Kreis in der Aufgabenhierarchie"));
    renderWithProviders(<TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />);
    await screen.findByText("Alpha");

    drag("Alpha", { toY: centreOf(2, 5) });

    expect(await screen.findByRole("alert")).toHaveTextContent("Verschieben fehlgeschlagen");
    expect(screen.getByRole("alert")).toHaveTextContent("Kreis in der Aufgabenhierarchie");
    // Kein voreiliger globaler Refresh: die Zeilen kehren einfach zurück.
    await waitFor(() => expect(renderedOrder()).toEqual(["Alpha", "Beta", "Gamma"]));
  });

  it("refreshes after a stale move and blocks the stale snapshot from retrying", async () => {
    const stale = Object.assign(new Error("Veraltete Revision"), {
      name: "ApiError",
      code: "stale_write_conflict",
    });
    mockedApi.moveTask.mockRejectedValue(stale);
    const rendered = renderWithProviders(
      <>
        <RefreshVersion />
        <TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />
      </>,
    );
    await screen.findByText("Alpha");

    drag("Alpha", { toY: centreOf(2, 5) });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Dieser Eintrag wurde auf einem anderen Gerät geändert",
    );
    await waitFor(() => expect(screen.getByTestId("refresh-version")).toHaveTextContent("1"));
    expect(renderedOrder()).toEqual(["Alpha", "Beta", "Gamma"]);

    drag("Alpha", { toY: centreOf(2, 5) });
    await flushMicrotasks();
    expect(mockedApi.moveTask).toHaveBeenCalledTimes(1);

    // A new array alone is not proof of freshness.
    rendered.rerender(
      <>
        <RefreshVersion />
        <TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />
      </>,
    );
    drag("Alpha", { toY: centreOf(2, 5) });
    await flushMicrotasks();
    expect(mockedApi.moveTask).toHaveBeenCalledTimes(1);

    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 1, revision: 3 }));
    rendered.rerender(
      <>
        <RefreshVersion />
        <TaskOutline
          tasks={[
            makeTask({ id: 1, title: "Alpha", position: 0, projectId: 5, revision: 2 }),
            makeTask({ id: 2, title: "Beta", position: 1, projectId: 5 }),
            makeTask({ id: 3, title: "Gamma", position: 2, projectId: 5 }),
          ]}
          emptyMessage="Nichts da"
          organizable
        />
      </>,
    );
    drag("Alpha", { toY: centreOf(2, 5) });
    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenLastCalledWith(1, {
        parentTaskId: null,
        projectId: 5,
        position: 2,
        expectedRevision: 2,
      }),
    );
  });

  it("ändert bei abgebrochenem Zeigerkontakt nichts", async () => {
    renderWithProviders(<TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />);
    await screen.findByText("Alpha");

    drag("Alpha", { toY: centreOf(2, 5), cancel: true });

    await waitFor(() => expect(screen.queryByTestId("task-drop-indicator")).toBeNull());
    expect(mockedApi.moveTask).not.toHaveBeenCalled();
    expect(renderedOrder()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("zeigt während des Ziehens eine Einfügelinie mit Zielebene an", async () => {
    renderWithProviders(<TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />);
    await screen.findByText("Alpha");

    stubRowGeometry();
    const handle = handleFor("Gamma");
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 32, clientY: centreOf(1, 5), pointerId: 1 });

    const indicator = await screen.findByTestId("task-drop-indicator");
    expect(indicator.dataset.depth).toBe("1");
    expect(await screen.findByText(/Unter „Beta“/)).toBeInTheDocument();

    // Abbruch per Escape lässt alles unverändert.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("task-drop-indicator")).toBeNull());
    expect(mockedApi.moveTask).not.toHaveBeenCalled();
  });

  it("bietet eine einzige Werkzeugleiste für die ausgewählte Aufgabe statt Bedienfelder je Zeile", async () => {
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 2 }));
    renderWithProviders(<TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />);
    await screen.findByText("Beta");

    expect(screen.queryByRole("toolbar")).toBeNull();
    await userEvent.click(handleFor("Beta"));

    const toolbars = screen.getAllByRole("toolbar");
    expect(toolbars).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Ablegen" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Nach oben" }));
    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenCalledWith(2, {
        parentTaskId: null,
        projectId: 5,
        position: 0,
        expectedRevision: 1,
      }),
    );
    expect(renderedOrder()).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("verschiebt per Tastatur direkt am Ziehgriff", async () => {
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 2, revision: 2 }));
    renderWithProviders(
      <TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />,
    );
    await screen.findByText("Beta");

    handleFor("Beta").focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenCalledWith(2, {
        parentTaskId: 1,
        position: 0,
        expectedRevision: 1,
      }),
    );
    expect(document.querySelectorAll(".task-row-children .task-row-title")[0]?.textContent).toBe("Beta");

    // The optimistic tree carries the exact next revision, so a second move
    // does not wait for a project refresh.
    await waitFor(() => expect(document.activeElement).toBe(handleFor("Beta")));
    handleFor("Beta").focus();
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenLastCalledWith(2, {
        parentTaskId: null,
        projectId: 5,
        position: 1,
        expectedRevision: 2,
      }),
    );
    expect(document.querySelectorAll(".task-row-children").length).toBe(0);
  });

  it("deaktiviert das Umbauen in gemischten Ansichten", async () => {
    const mixed = [
      makeTask({ id: 1, title: "Alpha", projectId: 5 }),
      makeTask({ id: 2, title: "Beta", projectId: 9 }),
    ];
    renderWithProviders(<TaskOutline tasks={mixed} emptyMessage="Nichts da" organizable />);
    await screen.findByText("Alpha");

    expect(screen.queryAllByRole("button", { name: /^Verschieben:/ })).toHaveLength(0);
  });

  it("bietet in kompilierten Ansichten ohne ausdrückliche Freigabe kein Umbauen an", async () => {
    // Heute/Eingang/Suche zeigen nur einen Ausschnitt einer Geschwistergruppe:
    // eine dort abgelesene Position würde serverseitig auf die vollständige
    // Gruppe angewendet und unsichtbare Zeilen mit umsortieren.
    vi.useFakeTimers();
    mockedApi.completeTask.mockResolvedValue(makeTask({ id: 1, status: "done" }));
    renderWithProviders(<TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /^Verschieben:/ })).toHaveLength(0);

    // Langes Drücken startet dort nichts – und darf die Wischgeste nicht abwürgen.
    const content = document.querySelectorAll<HTMLElement>(".task-row-content")[0]!;
    fireEvent.pointerDown(content, { clientX: 0, pointerId: 3 });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.pointerMove(content, { clientX: 120, pointerId: 3 });
    fireEvent.pointerUp(content, { pointerId: 3 });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.completeTask).toHaveBeenCalledWith(
      1,
      "leave_open",
      undefined,
      1,
    );
    expect(mockedApi.moveTask).not.toHaveBeenCalled();
  });

  it("öffnet nach einem Ziehen per langem Drücken nicht die Detailansicht", async () => {
    // Beim Loslassen erzeugt der Browser noch einen Klick auf das Element,
    // auf dem der Finger aufsetzte – hier die Zeilenschaltfläche. Ohne
    // Unterdrückung ginge direkt nach dem Verschieben das Detailfenster auf.
    vi.useFakeTimers();
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 1 }));
    const rendered = renderWithProviders(
      <>
        <TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />
        <OpenProbe />
      </>,
    );
    await act(async () => {
      await flushMicrotasks();
    });
    stubRowGeometry();

    const main = document.querySelectorAll<HTMLElement>(".task-row-main")[0]!;
    fireEvent.pointerDown(main, { clientX: 0, clientY: centreOf(0), pointerId: 7 });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.pointerMove(window, { clientX: 0, clientY: centreOf(2, 5), pointerId: 7 });
    fireEvent.pointerUp(window, { pointerId: 7 });
    await act(async () => {
      await flushMicrotasks();
    });
    // Der nachgereichte Klick des Browsers.
    fireEvent.click(main);
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockedApi.moveTask).toHaveBeenCalledWith(1, {
      parentTaskId: null,
      projectId: 5,
      position: 2,
      expectedRevision: 1,
    });
    expect(screen.getByTestId("offene-details")).toHaveTextContent("keine");

    rendered.rerender(
      <>
        <TaskOutline
          tasks={[
            makeTask({ id: 2, title: "Beta", position: 0, projectId: 5, revision: 2 }),
            makeTask({ id: 3, title: "Gamma", position: 1, projectId: 5, revision: 2 }),
            makeTask({ id: 1, title: "Alpha", position: 2, projectId: 5, revision: 3 }),
          ]}
          emptyMessage="Nichts da"
          organizable
        />
        <OpenProbe />
      </>,
    );
    // After authoritative refresh, the next tap opens normally.
    const refreshedMain = screen.getByRole("button", { name: "Alpha" });
    fireEvent.pointerDown(refreshedMain, { clientX: 0, clientY: centreOf(2), pointerId: 8 });
    fireEvent.pointerUp(refreshedMain, { pointerId: 8 });
    fireEvent.click(refreshedMain);
    expect(screen.getByTestId("offene-details")).toHaveTextContent("1");
  });

  it("klappt ein eingeklapptes Ziel beim Ablegen wieder auf", async () => {
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 3 }));
    const tasks = [
      makeTask({
        id: 1,
        title: "Alpha",
        position: 0,
        projectId: 5,
        children: [makeTask({ id: 2, title: "Kind", parentTaskId: 1, position: 0, projectId: 5 })],
      }),
      makeTask({ id: 3, title: "Gamma", position: 1, projectId: 5 }),
    ];
    renderWithProviders(<TaskOutline tasks={tasks} emptyMessage="Nichts da" organizable />);
    await screen.findByText("Kind");

    // Alpha einklappen: das Kind verschwindet aus der Ansicht.
    await userEvent.click(screen.getByRole("button", { name: "Einklappen" }));
    expect(screen.queryByText("Kind")).not.toBeInTheDocument();

    // Gamma direkt unter das eingeklappte Alpha ziehen (eine Ebene tiefer).
    drag("Gamma", { toY: centreOf(0, 5), offsetX: 32 });

    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenCalledWith(3, {
        parentTaskId: 1,
        position: 0,
        expectedRevision: 1,
      }),
    );
    // Die verschobene Zeile darf nicht im eingeklappten Zweig verschwinden.
    await waitFor(() => expect(screen.getByText("Gamma")).toBeInTheDocument());
    expect(screen.getByText("Kind")).toBeInTheDocument();
  });

  it("bleibt unter StrictMode funktionsfähig (doppelt ausgeführte Effekte)", async () => {
    // StrictMode hängt in der Entwicklung jeden Effekt einmal aus und wieder
    // ein. Ein „unmounted“-Merker, der dabei nicht zurückgesetzt wird, würde
    // jeden Zug ohne Refresh, ohne Rückabwicklung und dauerhaft „beschäftigt“
    // enden lassen.
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 1, revision: 2 }));
    renderWithProviders(
      <StrictMode>
        <TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />
      </StrictMode>,
    );
    await screen.findByText("Alpha");

    drag("Alpha", { toY: centreOf(2, 5) });

    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenCalledWith(1, {
        parentTaskId: null,
        projectId: 5,
        position: 2,
        expectedRevision: 1,
      }),
    );
    expect(renderedOrder()).toEqual(["Beta", "Gamma", "Alpha"]);
    // Position normalization does not stale the sibling snapshots, and the
    // moved row already has its deterministic next revision.
    await waitFor(() => expect(handleFor("Alpha")).not.toHaveAttribute("aria-busy", "true"));
    drag("Alpha", { toY: -10 });
    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenLastCalledWith(1, {
        parentTaskId: null,
        projectId: 5,
        position: 0,
        expectedRevision: 2,
      }),
    );
  });

  it("gibt zurückgehaltenen Geisterzeilen keinen Ziehgriff", async () => {
    // Eine Zeile, die nur noch als Rückhalte-Schnappschuss existiert, gehört
    // nicht mehr zur gespeicherten Geschwistergruppe: sie darf weder selbst
    // gezogen werden noch als Ablageziel die Indizes verschieben.
    const tasks = outlineTasks();
    mockedApi.completeTask.mockResolvedValue({
      ...tasks[0]!,
      revision: 2,
      status: "done",
    });
    const { rerender } = renderWithProviders(
      <TaskOutline tasks={tasks} emptyMessage="Nichts da" organizable />,
    );
    await screen.findByText("Alpha");
    await userEvent.click(screen.getAllByRole("button", { name: "Erledigt" })[0] as HTMLElement);
    await waitFor(() =>
      expect(mockedApi.completeTask).toHaveBeenCalledWith(
        1,
        "leave_open",
        undefined,
        1,
      ),
    );

    // Der Refetch liefert Alpha nicht mehr – die Zeile bleibt als Geist stehen.
    rerender(<TaskOutline tasks={[tasks[1]!, tasks[2]!]} emptyMessage="Nichts da" organizable />);

    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Verschieben:/ })).toHaveLength(2));
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verschieben: Alpha" })).toBeNull();
  });

  it("lässt Wischgesten und Klicks unangetastet", async () => {
    mockedApi.completeTask.mockResolvedValue(makeTask({ id: 1, status: "done" }));
    renderWithProviders(<TaskOutline tasks={outlineTasks()} emptyMessage="Nichts da" organizable />);
    await screen.findByText("Alpha");

    const content = document.querySelectorAll<HTMLElement>(".task-row-content")[0]!;
    fireEvent.pointerDown(content, { clientX: 0, pointerId: 2 });
    fireEvent.pointerMove(content, { clientX: 120, pointerId: 2 });
    fireEvent.pointerUp(content, { pointerId: 2 });

    await waitFor(() =>
      expect(mockedApi.completeTask).toHaveBeenCalledWith(
        1,
        "leave_open",
        undefined,
        1,
      ),
    );
    expect(mockedApi.moveTask).not.toHaveBeenCalled();

    // Ein gewöhnlicher Klick öffnet weiterhin die Aktionen der Zeile …
    const gammaRow = screen.getByText("Gamma").closest(".task-row") as HTMLElement;
    await userEvent.click(within(gammaRow).getByRole("button", { name: "Weitere Aktionen" }));
    expect(within(gammaRow).getByRole("group", { name: "Weitere Aktionen" })).toBeInTheDocument();
    // … und der Ziehgriff bleibt der einzige Struktur-Bedienknopf darin.
    expect(within(gammaRow).queryByRole("toolbar")).toBeNull();
    expect(mockedApi.moveTask).not.toHaveBeenCalled();
  });

  it("bewältigt tiefe Bäume", async () => {
    mockedApi.moveTask.mockResolvedValue(makeTask({ id: 1 }));
    const depth = 30;
    let node = makeTask({ id: 100 + depth, title: `Ebene ${depth}`, parentTaskId: 100 + depth - 1, projectId: 5 });
    for (let level = depth - 1; level >= 1; level -= 1) {
      node = makeTask({
        id: 100 + level,
        title: `Ebene ${level}`,
        parentTaskId: level === 1 ? null : 100 + level - 1,
        projectId: 5,
        position: 0,
        children: [node],
      });
    }
    const last = makeTask({ id: 900, title: "Letzte", position: 1, projectId: 5 });
    renderWithProviders(<TaskOutline tasks={[node, last]} emptyMessage="Nichts da" organizable />);
    await screen.findByText(`Ebene ${depth}`);

    // Alle 31 Zeilen sind sichtbar; die letzte an den Anfang ziehen.
    expect(document.querySelectorAll(".task-row-content")).toHaveLength(depth + 1);
    act(() => {
      drag("Letzte", { toY: -10 });
    });

    await waitFor(() =>
      expect(mockedApi.moveTask).toHaveBeenCalledWith(900, {
        parentTaskId: null,
        projectId: 5,
        position: 0,
        expectedRevision: 1,
      }),
    );
    expect(renderedOrder()[0]).toBe("Letzte");
  });
});
