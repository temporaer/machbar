import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { DeveloperModeRoute } from "./App";
import {
  DEVELOPER_MODE_STORAGE_KEY,
  DeveloperModeProvider,
} from "./lib/developerMode";

function renderDebugRoute() {
  return render(
    <DeveloperModeProvider>
      <MemoryRouter initialEntries={["/more/debug"]}>
        <Routes>
          <Route path="/more" element={<div>More page</div>} />
          <Route
            path="/more/debug"
            element={
              <DeveloperModeRoute>
                <div>Debug page</div>
              </DeveloperModeRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    </DeveloperModeProvider>,
  );
}

describe("DeveloperModeRoute", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("redirects direct Debug navigation while developer mode is disabled", () => {
    renderDebugRoute();
    expect(screen.getByText("More page")).toBeInTheDocument();
    expect(screen.queryByText("Debug page")).not.toBeInTheDocument();
  });

  it("allows Debug navigation after developer mode is enabled", () => {
    window.localStorage.setItem(DEVELOPER_MODE_STORAGE_KEY, "true");
    renderDebugRoute();
    expect(screen.getByText("Debug page")).toBeInTheDocument();
  });
});
