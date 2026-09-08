import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { Task } from "@machbar/shared";
import { makeTask } from "../test/fixtures";
import {
  InteractionScopeProvider,
  useInteractionScope,
} from "../lib/interactionScope";
import { InboxFocusRail } from "./InboxPage";

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
