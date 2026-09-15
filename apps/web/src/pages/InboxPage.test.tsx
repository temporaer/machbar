import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { Task } from "@machbar/shared";
import { makeMember, makeTask } from "../test/fixtures";
import {
  InteractionScopeProvider,
  useInteractionScope,
} from "../lib/interactionScope";
import { InboxFocusRail, InboxPage } from "./InboxPage";
import { api } from "../lib/api";
import { renderWithProviders } from "../test/testUtils";

vi.mock("../lib/api", () => ({
  api: {
    getMembers: vi.fn(),
    getInbox: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function ScopeProbe() {
  const location = useLocation();
  const {
    activeId,
    openRailId,
    openLifecycleId,
    setOpenLifecycle,
    setOpenRail,
  } = useInteractionScope();
  return (
    <>
      <output data-testid="location">
        {location.pathname}
        {location.search}
      </output>
      <output data-testid="active-id">{activeId ?? "none"}</output>
      <output data-testid="open-rail-id">{openRailId ?? "none"}</output>
      <output data-testid="open-lifecycle-id">
        {openLifecycleId ?? "none"}
      </output>
      <button type="button" onClick={() => setOpenLifecycle(123)}>
        open lifecycle
      </button>
      <button type="button" onClick={() => setOpenRail(456)}>
        open other rail
      </button>
      <button type="button" onClick={() => setOpenRail(null)}>
        close rail
      </button>
    </>
  );
}

function Harness({ tasks }: { tasks: Task[] | null | undefined }) {
  const location = useLocation();
  return (
    <>
      <InboxFocusRail
        tasks={tasks}
        focusId={new URLSearchParams(location.search).get("focus")}
      />
      <ScopeProbe />
    </>
  );
}

function renderHarness(tasks: Task[] | null | undefined) {
  return render(
    <MemoryRouter initialEntries={["/inbox?focus=123&view=compact"]}>
      <InteractionScopeProvider>
        <Routes>
          <Route path="/inbox" element={<Harness tasks={tasks} />} />
        </Routes>
      </InteractionScopeProvider>
    </MemoryRouter>,
  );
}

describe("InboxFocusRail", () => {
  it("consumes focus once via replace and does not reopen the rail after lifecycle opens", async () => {
    const task = makeTask({ id: 123, title: "Milch kaufen" });
    const view = renderHarness([]);

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/inbox?focus=123&view=compact",
    );
    expect(screen.getByTestId("open-rail-id")).toHaveTextContent("none");

    view.rerender(
      <MemoryRouter initialEntries={["/inbox?focus=123&view=compact"]}>
        <InteractionScopeProvider>
          <Routes>
            <Route path="/inbox" element={<Harness tasks={[task]} />} />
          </Routes>
        </InteractionScopeProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("active-id")).toHaveTextContent("123"),
    );
    expect(screen.getByTestId("open-rail-id")).toHaveTextContent("123");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/inbox?view=compact",
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: "open lifecycle" }));
    expect(screen.getByTestId("open-lifecycle-id")).toHaveTextContent("123");
    expect(screen.getByTestId("open-rail-id")).toHaveTextContent("none");

    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId("open-lifecycle-id")).toHaveTextContent("none");
    expect(screen.getByTestId("open-rail-id")).toHaveTextContent("none");
  });

  it("does not replay a consumed focus request after closing, switching rows, or refetching", async () => {
    const task = makeTask({ id: 123, title: "Milch kaufen" });
    const view = renderHarness([task]);

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/inbox?view=compact",
      ),
    );
    expect(screen.getByTestId("open-rail-id")).toHaveTextContent("123");

    await userEvent.click(screen.getByRole("button", { name: "close rail" }));
    expect(screen.getByTestId("open-rail-id")).toHaveTextContent("none");

    view.rerender(
      <MemoryRouter initialEntries={["/inbox?focus=123&view=compact"]}>
        <InteractionScopeProvider>
          <Routes>
            <Route path="/inbox" element={<Harness tasks={[{ ...task }]} />} />
          </Routes>
        </InteractionScopeProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/inbox?view=compact");
    expect(screen.getByTestId("open-rail-id")).toHaveTextContent("none");

    await userEvent.click(screen.getByRole("button", { name: "open other rail" }));
    expect(screen.getByTestId("open-rail-id")).toHaveTextContent("456");

    view.rerender(
      <MemoryRouter initialEntries={["/inbox?focus=123&view=compact"]}>
        <InteractionScopeProvider>
          <Routes>
            <Route path="/inbox" element={<Harness tasks={[task]} />} />
          </Routes>
        </InteractionScopeProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("open-rail-id")).toHaveTextContent("456");
  });
});

describe("InboxPage scope toggle", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1, name: "Mira" })]);
    mockedApi.getInbox.mockResolvedValue([]);
  });

  it("cycles mine -> household -> work and requests the matching inbox scope", async () => {
    const { container } = renderWithProviders(<InboxPage />);

    await waitFor(() =>
      expect(mockedApi.getInbox).toHaveBeenLastCalledWith(null, "mine"),
    );

    const header = container.querySelector<HTMLElement>(".page-header")!;
    const toggle = within(header).getByRole("button", {
      name: "Ungeklärtes aller Personen anzeigen",
    });
    expect(toggle).toHaveClass("page-header-button", "inbox-scope-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(toggle);
    await waitFor(() =>
      expect(mockedApi.getInbox).toHaveBeenLastCalledWith(null, "all"),
    );
    expect(toggle).toHaveAccessibleName("Nur eigenes ungeklärtes Arbeitsmaterial anzeigen");
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(toggle);
    await waitFor(() =>
      expect(mockedApi.getInbox).toHaveBeenLastCalledWith(null, "work"),
    );
    expect(toggle).toHaveAccessibleName("Nur eigenes ungeklärtes Material anzeigen");

    await userEvent.click(toggle);
    await waitFor(() =>
      expect(mockedApi.getInbox).toHaveBeenLastCalledWith(null, "mine"),
    );
  });

  it("remembers the scope written by another view while this browser tab remains open", async () => {
    window.sessionStorage.setItem("machbar:today-scope", "work");
    renderWithProviders(<InboxPage />);

    await waitFor(() =>
      expect(mockedApi.getInbox).toHaveBeenLastCalledWith(null, "work"),
    );
    expect(
      screen.getByRole("button", {
        name: "Nur eigenes ungeklärtes Material anzeigen",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
