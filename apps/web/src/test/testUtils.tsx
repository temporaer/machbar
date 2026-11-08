import { useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { IdentityProvider } from "../lib/identity";
import { RefreshProvider } from "../lib/refresh";
import { TaskDetailProvider } from "../lib/taskDetailContext";
import { TaskWorkflowProvider } from "../lib/taskWorkflowContext";
import { ProjectWorkflowProvider } from "../lib/projectWorkflowContext";
import { TaskActionsProvider } from "../lib/useTaskActions";
import { ProjectActionsProvider } from "../lib/useProjectActions";
import { InteractionScopeProvider } from "../lib/interactionScope";
import { LocaleProvider, type Locale } from "../lib/locale";
import { ThemeProvider } from "../lib/theme";
import { SwipeCoachProvider } from "../lib/swipeCoach";
import { DeveloperModeProvider } from "../lib/developerMode";
import { createQueryClient } from "../lib/projectQueries";

function AllProviders({
  children,
  initialEntries,
  locale,
}: {
  children: ReactNode;
  initialEntries?: ComponentProps<typeof MemoryRouter>["initialEntries"];
  locale: Locale;
}) {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <LocaleProvider initialLocale={locale}>
        <DeveloperModeProvider>
          <MemoryRouter {...(initialEntries ? { initialEntries } : {})}>
            <IdentityProvider>
              <RefreshProvider>
                  <SwipeCoachProvider>
                    <TaskActionsProvider>
                      <ProjectActionsProvider>
                        <InteractionScopeProvider>
                          <TaskDetailProvider>
                            <TaskWorkflowProvider>
                              <ProjectWorkflowProvider>{children}</ProjectWorkflowProvider>
                            </TaskWorkflowProvider>
                          </TaskDetailProvider>
                        </InteractionScopeProvider>
                      </ProjectActionsProvider>
                    </TaskActionsProvider>
                  </SwipeCoachProvider>
              </RefreshProvider>
            </IdentityProvider>
          </MemoryRouter>
        </DeveloperModeProvider>
      </LocaleProvider>
    </ThemeProvider>
    </QueryClientProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options: {
    initialEntries?: ComponentProps<typeof MemoryRouter>["initialEntries"];
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
