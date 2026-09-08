import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { IdentityProvider, useIdentity } from "./lib/identity";
import { RefreshProvider } from "./lib/refresh";
import { TaskDetailProvider, useTaskDetail } from "./lib/taskDetailContext";
import { TaskWorkflowProvider } from "./lib/taskWorkflowContext";
import { ProjectWorkflowProvider } from "./lib/projectWorkflowContext";
import { SwipeSettingsProvider } from "./lib/swipeSettings";
import { RailConfigProvider } from "./lib/railConfigContext";
import { TaskActionsProvider } from "./lib/useTaskActions";
import { ProjectActionsProvider } from "./lib/useProjectActions";
import { useGlobalNavigationKeys } from "./lib/useGlobalNavigationKeys";
import { IdentityGate } from "./components/IdentityGate";
import { BottomNav } from "./components/BottomNav";
import { TaskDetailSheet } from "./components/TaskDetailSheet";
import { TaskWorkflowHost } from "./components/TaskWorkflowHost";
import { ProjectWorkflowHost } from "./components/ProjectWorkflowHost";
import { TodayPage } from "./pages/TodayPage";
import { InboxPage } from "./pages/InboxPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
import { WaitingPage } from "./pages/WaitingPage";
import { MorePage } from "./pages/MorePage";
import { AllPage } from "./pages/AllPage";
import { ReviewPage } from "./pages/ReviewPage";
import { WeekPage } from "./pages/WeekPage";
import { TagsPage } from "./pages/TagsPage";
import { SharePage } from "./pages/SharePage";
import { TaskDeepLinkPage } from "./pages/TaskDeepLinkPage";
import { ActivityPage } from "./pages/ActivityPage";
import { DebugPage } from "./pages/DebugPage";
import { HomeAssistantPage } from "./pages/HomeAssistantPage";
import { LocaleProvider } from "./lib/locale";
import { ThemeProvider } from "./lib/theme";
import { SwipeCoachProvider } from "./lib/swipeCoach";
import { DeveloperModeProvider, useDeveloperMode } from "./lib/developerMode";
import { useStrings } from "./lib/strings";

function TaskDetailHost() {
  const { openTaskId } = useTaskDetail();
  if (openTaskId === null) return null;
  return <TaskDetailSheet />;
}

export function DeveloperModeRoute({ children }: { children: ReactNode }) {
  const { developerMode } = useDeveloperMode();
  return developerMode ? children : <Navigate to="/more" replace />;
}

function IdentityAwareRefreshProvider({ children }: { children: ReactNode }) {
  const { authEnabled, authenticated, authLoading } = useIdentity();
  return (
    <RefreshProvider
      remoteSyncEnabled={!authLoading && (!authEnabled || authenticated)}
    >
      {children}
    </RefreshProvider>
  );
}

function Shell() {
  const { currentMemberId } = useIdentity();
  const location = useLocation();
  const strings = useStrings();
  const navigationHint = useGlobalNavigationKeys();
  return (
    <div className="app-shell">
      <main className="app-main">
        <IdentityGate>
          <Routes>
            <Route path="/" element={<Navigate to="/today" replace />} />
            <Route path="/today" element={<TodayPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:id" element={<ProjectDetailPage />} />
            <Route path="/waiting" element={<WaitingPage />} />
            <Route path="/more" element={<MorePage />} />
            <Route path="/more/week" element={<WeekPage />} />
            <Route path="/more/all" element={<AllPage />} />
            <Route path="/more/review" element={<ReviewPage />} />
            <Route path="/more/tags" element={<TagsPage />} />
            <Route path="/more/activity" element={<ActivityPage />} />
            <Route
              path="/more/integrations/home-assistant"
              element={<HomeAssistantPage />}
            />
            <Route
              path="/more/debug"
              element={
                <DeveloperModeRoute>
                  <DebugPage />
                </DeveloperModeRoute>
              }
            />
            <Route path="/share" element={<SharePage />} />
            <Route path="/tasks/:id" element={<TaskDeepLinkPage />} />
            <Route path="*" element={<Navigate to="/today" replace />} />
          </Routes>
          <TaskDetailHost />
          <TaskWorkflowHost />
          <ProjectWorkflowHost />
        </IdentityGate>
      </main>
      {navigationHint.prefixOpen ? (
        <div className="which-key-hint" role="status" aria-live="polite">
          <span>g …</span>
          {navigationHint.choices.map((choice) => (
            <span key={choice.id}>
              <kbd>{choice.keys[0]?.replace(/^g\s+/, "")}</kbd>{" "}
              {choice.label(strings)}
            </span>
          ))}
        </div>
      ) : null}
      {currentMemberId !== null && location.pathname !== "/share" ? <BottomNav /> : null}
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <LocaleProvider>
        <DeveloperModeProvider>
          <IdentityProvider>
            <IdentityAwareRefreshProvider>
              <SwipeSettingsProvider>
                <RailConfigProvider>
                  <SwipeCoachProvider>
                    <TaskActionsProvider>
                      <ProjectActionsProvider>
                        <TaskDetailProvider>
                          <TaskWorkflowProvider>
                            <ProjectWorkflowProvider>
                              <HashRouter>
                                <Shell />
                              </HashRouter>
                            </ProjectWorkflowProvider>
                          </TaskWorkflowProvider>
                        </TaskDetailProvider>
                      </ProjectActionsProvider>
                    </TaskActionsProvider>
                  </SwipeCoachProvider>
                </RailConfigProvider>
              </SwipeSettingsProvider>
            </IdentityAwareRefreshProvider>
          </IdentityProvider>
        </DeveloperModeProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}
