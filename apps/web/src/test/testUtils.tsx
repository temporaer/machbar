import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { TaskDetailProvider } from "../lib/taskDetailContext";
import { SwipeSettingsProvider } from "../lib/swipeSettings";
import { RailConfigProvider } from "../lib/railConfigContext";
import { TaskActionsProvider } from "../lib/useTaskActions";
import { ProjectActionsProvider } from "../lib/useProjectActions";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { LocaleProvider, type Locale } from "../lib/locale";
import { ThemeProvider } from "../lib/theme";
import { SwipeCoachProvider } from "../lib/swipeCoach";
import { DeveloperModeProvider } from "../lib/developerMode";

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
        <DeveloperModeProvider>
          <MemoryRouter {...(initialEntries ? { initialEntries } : {})}>
            <IdentityProvider>
              <RefreshProvider>
                <SwipeSettingsProvider>
                  <RailConfigProvider>
                    <SwipeCoachProvider>
                      <TaskActionsProvider>
                        <ProjectActionsProvider>
                          <InteractionScopeProvider>
                            <TaskDetailProvider>{children}</TaskDetailProvider>
                          </InteractionScopeProvider>
                        </ProjectActionsProvider>
                      </TaskActionsProvider>
                    </SwipeCoachProvider>
                  </RailConfigProvider>
                </SwipeSettingsProvider>
              </RefreshProvider>
            </IdentityProvider>
          </MemoryRouter>
        </DeveloperModeProvider>
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
