import { useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { MemoryRouter, RouterProvider, createMemoryRouter } from "react-router-dom";
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

function AllProviders({
  children,
  initialEntries,
  locale,
}: {
  children: ReactNode;
  initialEntries?: ComponentProps<typeof MemoryRouter>["initialEntries"];
  locale: Locale;
}) {
  return (
    <ThemeProvider>
      <LocaleProvider initialLocale={locale}>
        <DeveloperModeProvider>
          <TestRouter initialEntries={initialEntries}>
            <IdentityProvider>
              <RefreshProvider>
                  <SwipeCoachProvider>
                    <TaskActionsProvider>
                      <ProjectActionsProvider>
                        <InteractionScopeProvider>
                          <TaskWorkflowProvider>
                            <TaskDetailProvider>
                                <ProjectWorkflowProvider>{children}</ProjectWorkflowProvider>
                              </TaskDetailProvider>
                            </TaskWorkflowProvider>
                        </InteractionScopeProvider>
                      </ProjectActionsProvider>
                    </TaskActionsProvider>
                  </SwipeCoachProvider>
              </RefreshProvider>
            </IdentityProvider>
          </TestRouter>
        </DeveloperModeProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}

function TestRouter({
  children,
  initialEntries,
}: {
  children: ReactNode;
  initialEntries?: ComponentProps<typeof import("react-router-dom").MemoryRouter>["initialEntries"];
}) {
  const [router] = useState(() => createMemoryRouter([
    { path: "*", element: <>{children}</> },
  ], initialEntries ? { initialEntries } : undefined));
  return <RouterProvider router={router} />;
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
