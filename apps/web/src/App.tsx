import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { IdentityProvider, useIdentity } from "./lib/identity";
import { RefreshProvider } from "./lib/refresh";
import { TaskDetailProvider, useTaskDetail } from "./lib/taskDetailContext";
import { SwipeSettingsProvider } from "./lib/swipeSettings";
import { IdentityGate } from "./components/IdentityGate";
import { BottomNav } from "./components/BottomNav";
import { TaskDetailSheet } from "./components/TaskDetailSheet";
import { TodayPage } from "./pages/TodayPage";
import { InboxPage } from "./pages/InboxPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
import { WaitingPage } from "./pages/WaitingPage";
import { MorePage } from "./pages/MorePage";
import { SearchPage } from "./pages/SearchPage";
import { StuckPage } from "./pages/StuckPage";
import { BacklogReviewPage } from "./pages/BacklogReviewPage";
import { RefinementPage } from "./pages/RefinementPage";
import { TagsPage } from "./pages/TagsPage";
import { SharePage } from "./pages/SharePage";
import { TaskDeepLinkPage } from "./pages/TaskDeepLinkPage";
import { ActivityPage } from "./pages/ActivityPage";
import { DebugPage } from "./pages/DebugPage";
import { LocaleProvider } from "./lib/locale";
import { ThemeProvider } from "./lib/theme";
import { SwipeCoachProvider } from "./lib/swipeCoach";

function TaskDetailHost() {
  const { openTaskId } = useTaskDetail();
  if (openTaskId === null) return null;
  return <TaskDetailSheet />;
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
            <Route path="/more/search" element={<SearchPage />} />
            <Route path="/more/stuck" element={<StuckPage />} />
            <Route path="/more/backlog" element={<BacklogReviewPage />} />
            <Route path="/more/refinement" element={<RefinementPage />} />
            <Route path="/more/tags" element={<TagsPage />} />
            <Route path="/more/activity" element={<ActivityPage />} />
            <Route path="/more/debug" element={<DebugPage />} />
            <Route path="/share" element={<SharePage />} />
            <Route path="/tasks/:id" element={<TaskDeepLinkPage />} />
            <Route path="*" element={<Navigate to="/today" replace />} />
          </Routes>
          <TaskDetailHost />
        </IdentityGate>
      </main>
      {currentMemberId !== null && location.pathname !== "/share" ? <BottomNav /> : null}
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <LocaleProvider>
        <IdentityProvider>
          <IdentityAwareRefreshProvider>
            <SwipeSettingsProvider>
              <SwipeCoachProvider>
                <TaskDetailProvider>
                  <HashRouter>
                    <Shell />
                  </HashRouter>
                </TaskDetailProvider>
              </SwipeCoachProvider>
            </SwipeSettingsProvider>
          </IdentityAwareRefreshProvider>
        </IdentityProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}
