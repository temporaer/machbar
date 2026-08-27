import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { TaskDetailProvider } from "../lib/taskDetailContext";
import { SwipeSettingsProvider } from "../lib/swipeSettings";

function AllProviders({
  children,
  initialEntries,
}: {
  children: ReactNode;
  initialEntries?: string[] | undefined;
}) {
  return (
    <MemoryRouter {...(initialEntries ? { initialEntries } : {})}>
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

export function renderWithProviders(
  ui: ReactElement,
  options: { initialEntries?: string[] | undefined } = {},
) {
  return render(ui, {
    wrapper: ({ children }) => (
      <AllProviders initialEntries={options.initialEntries}>
        {children}
      </AllProviders>
    ),
  });
}
