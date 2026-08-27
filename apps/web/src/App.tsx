import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
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

function TaskDetailHost() {
  const { openTaskId } = useTaskDetail();
  if (openTaskId === null) return null;
  return <TaskDetailSheet />;
}

function Shell() {
  const { currentMemberId } = useIdentity();
  const location = useLocation();
  return (
    <div className="app-shell">
      <main className="app-main">
        <IdentityGate>
          <Routes>
            <Route path="/" element={<Navigate to="/heute" replace />} />
            <Route path="/heute" element={<TodayPage />} />
            <Route path="/eingang" element={<InboxPage />} />
            <Route path="/projekte" element={<ProjectsPage />} />
            <Route path="/projekte/:id" element={<ProjectDetailPage />} />
            <Route path="/wartet" element={<WaitingPage />} />
            <Route path="/mehr" element={<MorePage />} />
            <Route path="/mehr/suche" element={<SearchPage />} />
            <Route path="/mehr/festgefahren" element={<StuckPage />} />
            <Route path="/mehr/backlog" element={<BacklogReviewPage />} />
            <Route path="/mehr/refinement" element={<RefinementPage />} />
            <Route path="/mehr/tags" element={<TagsPage />} />
            <Route path="/share" element={<SharePage />} />
            <Route path="/aufgaben/:id" element={<TaskDeepLinkPage />} />
            <Route path="*" element={<Navigate to="/heute" replace />} />
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
    <IdentityProvider>
      <RefreshProvider>
        <SwipeSettingsProvider>
          <TaskDetailProvider>
            <HashRouter>
              <Shell />
            </HashRouter>
          </TaskDetailProvider>
        </SwipeSettingsProvider>
      </RefreshProvider>
    </IdentityProvider>
  );
}
