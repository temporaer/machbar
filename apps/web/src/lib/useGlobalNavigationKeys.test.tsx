import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { useGlobalNavigationKeys } from "./useGlobalNavigationKeys";
import { TaskActionsProvider } from "./useTaskActions";
import { ProjectActionsProvider } from "./useProjectActions";
import { TaskDetailProvider } from "./taskDetailContext";
import { IdentityProvider } from "./identity";
import { RefreshProvider } from "./refresh";
import { SwipeSettingsProvider } from "./swipeSettings";
import { api } from "./api";
import { makeMember } from "../test/fixtures";

vi.mock("./api", () => ({
  api: {
    getMembers: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api, true);

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
}

function GlobalNavHost() {
  useGlobalNavigationKeys();
  return (
    <Routes>
      <Route path="/today" element={<LocationProbe />} />
      <Route path="/inbox" element={<LocationProbe />} />
      <Route path="/projects" element={<LocationProbe />} />
      <Route path="/waiting" element={<LocationProbe />} />
      <Route path="/more" element={<LocationProbe />} />
    </Routes>
  );
}

function renderNavHost() {
  return render(
    <MemoryRouter initialEntries={["/today"]}>
      <IdentityProvider>
        <RefreshProvider>
          <SwipeSettingsProvider>
            <TaskActionsProvider>
              <ProjectActionsProvider>
                <TaskDetailProvider>
                  <GlobalNavHost />
                </TaskDetailProvider>
              </ProjectActionsProvider>
            </TaskActionsProvider>
          </SwipeSettingsProvider>
        </RefreshProvider>
      </IdentityProvider>
    </MemoryRouter>,
  );
}

describe("useGlobalNavigationKeys (g-prefix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getMembers.mockResolvedValue([makeMember({ id: 1 })]);
  });

  it("navigates with g i / g p / g w / g m", async () => {
    renderNavHost();
    await screen.findByTestId("path");

    await userEvent.keyboard("gi");
    expect(await screen.findByTestId("path")).toHaveTextContent("/inbox");

    await userEvent.keyboard("gp");
    expect(await screen.findByTestId("path")).toHaveTextContent("/projects");

    await userEvent.keyboard("gw");
    expect(await screen.findByTestId("path")).toHaveTextContent("/waiting");

    await userEvent.keyboard("gm");
    expect(await screen.findByTestId("path")).toHaveTextContent("/more");

    await userEvent.keyboard("gt");
    expect(await screen.findByTestId("path")).toHaveTextContent("/today");
  });

  it("does not navigate while a text field is focused", async () => {
    render(
      <MemoryRouter initialEntries={["/today"]}>
        <IdentityProvider>
          <RefreshProvider>
            <SwipeSettingsProvider>
              <TaskActionsProvider>
                <ProjectActionsProvider>
                  <TaskDetailProvider>
                    <input aria-label="Freitext" />
                    <GlobalNavHost />
                  </TaskDetailProvider>
                </ProjectActionsProvider>
              </TaskActionsProvider>
            </SwipeSettingsProvider>
          </RefreshProvider>
        </IdentityProvider>
      </MemoryRouter>,
    );
    await screen.findByTestId("path");

    await userEvent.click(screen.getByLabelText("Freitext"));
    await userEvent.keyboard("gi");

    expect(screen.getByTestId("path")).toHaveTextContent("/today");
  });

  it("ignores an unrecognized second key and does not navigate", async () => {
    renderNavHost();
    await screen.findByTestId("path");

    await userEvent.keyboard("gx");

    expect(screen.getByTestId("path")).toHaveTextContent("/today");
  });
});
