import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { TaskDetailProvider } from "../lib/taskDetailContext";
import { SwipeSettingsProvider } from "../lib/swipeSettings";
import { LocaleProvider, type Locale } from "../lib/locale";
import { ThemeProvider } from "../lib/theme";

function AllProviders({
  children,
  initialEntries,
  locale,
}: {
  children: ReactNode;
  initialEntries?: string[] | undefined;
  locale: Locale;
}) {
  return (
    <ThemeProvider>
      <LocaleProvider initialLocale={locale}>
        <MemoryRouter {...(initialEntries ? { initialEntries } : {})}>
          <IdentityProvider>
            <RefreshProvider>
              <SwipeSettingsProvider>
                <TaskDetailProvider>{children}</TaskDetailProvider>
              </SwipeSettingsProvider>
            </RefreshProvider>
          </IdentityProvider>
        </MemoryRouter>
      </LocaleProvider>
    </ThemeProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options: {
    initialEntries?: string[] | undefined;
    locale?: Locale | undefined;
  } = {},
) {
  return render(ui, {
    wrapper: ({ children }) => (
      <AllProviders
        initialEntries={options.initialEntries}
        locale={options.locale ?? "de"}
      >
        {children}
      </AllProviders>
    ),
  });
}
