import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { TaskDetailProvider } from "../lib/taskDetailContext";
import { SwipeSettingsProvider } from "../lib/swipeSettings";

function AllProviders({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <IdentityProvider>
        <RefreshProvider>
          <SwipeSettingsProvider>
            <TaskDetailProvider>{children}</TaskDetailProvider>
          </SwipeSettingsProvider>
        </RefreshProvider>
      </IdentityProvider>
    </MemoryRouter>
  );
}

export function renderWithProviders(ui: ReactElement) {
  return render(ui, { wrapper: AllProviders });
}
