import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { TaskDetailProvider } from "../lib/taskDetailContext";

function AllProviders({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <IdentityProvider>
        <RefreshProvider>
          <TaskDetailProvider>{children}</TaskDetailProvider>
        </RefreshProvider>
      </IdentityProvider>
    </MemoryRouter>
  );
}

export function renderWithProviders(ui: ReactElement) {
  return render(ui, { wrapper: AllProviders });
}
