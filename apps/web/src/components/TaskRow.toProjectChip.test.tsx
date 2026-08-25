import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom";
import { render, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { TaskDetailProvider } from "../lib/taskDetailContext";
import { SwipeSettingsProvider } from "../lib/swipeSettings";
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
  },
}));

const mockedApi = vi.mocked(api, true);

/**
 * `renderWithProviders` (src/test/testUtils.tsx) hard-codes its own bare
 * `<MemoryRouter>` with no routes, so it can't observe an actual navigation.
 * This local wrapper mirrors the same provider stack but also declares a
 * `/projekte/:id` route with a distinct marker, so clicking the "Zum
 * Projekt" chip can be asserted to have really navigated there — not just
 * that `navigate()` was called with the right string.
 */
function renderAtRootWithProjectRoute(ui: ReactElement) {
  function ProjectRouteMarker() {
    const { id } = useParams();
    return <div data-testid="project-page">Projektseite {id}</div>;
  }
  function Providers({ children }: { children: ReactNode }) {
    return (
      <IdentityProvider>
        <RefreshProvider>
          <SwipeSettingsProvider>
            <TaskDetailProvider>{children}</TaskDetailProvider>
          </SwipeSettingsProvider>
        </RefreshProvider>
      </IdentityProvider>
    );
  }
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Providers>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/projekte/:id" element={<ProjectRouteMarker />} />
        </Routes>
      </Providers>
    </MemoryRouter>,
  );
}

/** Simulates a horizontal drag past the swipe threshold and releases it. */
function swipe(container: HTMLElement, deltaX: number) {
  const content = container.querySelector(".task-row-content") as HTMLElement;
  fireEvent.pointerDown(content, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(content, { clientX: deltaX, pointerId: 1 });
  fireEvent.pointerUp(content, { clientX: deltaX, pointerId: 1 });
}

describe("TaskRow – 'Zum Projekt' chip navigates to the task's project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  it("reveals an enabled 'Zum Projekt' chip via a left-swipe and navigates to /projekte/:id for a task that belongs to a project", async () => {
    const task = makeTask({ id: 50, title: "Angebot erstellen", status: "actionable", projectId: 77 });
    const { container } = renderAtRootWithProjectRoute(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Angebot erstellen");

    swipe(container, -100);

    const chip = screen.getByRole("button", { name: "Zum Projekt" });
    expect(chip).toBeEnabled();

    await userEvent.click(chip);

    expect(await screen.findByTestId("project-page")).toHaveTextContent("Projektseite 77");
    // Using the chip must also close the strip, same as every other chip.
    expect(screen.queryByRole("group", { name: "Weitere Aktionen" })).not.toBeInTheDocument();
  });

  it("also navigates when the chip strip is opened via the ⋯ kebab (non-gesture access)", async () => {
    const task = makeTask({ id: 51, title: "Kunde kontaktieren", status: "actionable", projectId: 12 });
    renderAtRootWithProjectRoute(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Kunde kontaktieren");

    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await userEvent.click(screen.getByRole("button", { name: "Zum Projekt" }));

    expect(await screen.findByTestId("project-page")).toHaveTextContent("Projektseite 12");
  });

  it("renders the chip clearly disabled (and never navigates) for an inbox/projectless task", async () => {
    const task = makeTask({ id: 52, title: "Wäsche waschen", status: "actionable", projectId: null });
    const { container } = renderAtRootWithProjectRoute(<TaskOutline tasks={[task]} emptyMessage="Nichts da" />);
    await screen.findByText("Wäsche waschen");

    swipe(container, -100);

    const chip = screen.getByRole("button", { name: "Zum Projekt" });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute("aria-disabled", "true");

    // A disabled button doesn't dispatch a click at all in the browser/jsdom,
    // but assert the outcome directly too: no navigation ever happens.
    fireEvent.click(chip);
    expect(screen.queryByTestId("project-page")).not.toBeInTheDocument();
    // Still on the task list, chip strip untouched by the failed click.
    expect(screen.getByRole("button", { name: "Zum Projekt" })).toBeInTheDocument();
  });
});
