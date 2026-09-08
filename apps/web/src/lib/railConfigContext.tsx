import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ProjectRailCommand, TaskRailCommand } from "./commands";
import { useIdentity } from "./identity";
import {
  readRailFavorites,
  writeRailFavorites,
} from "./railConfig";

interface RailConfigContextValue {
  taskFavorites: readonly TaskRailCommand[];
  projectFavorites: readonly ProjectRailCommand[];
  setTaskFavorites: (favorites: readonly TaskRailCommand[]) => void;
  setProjectFavorites: (favorites: readonly ProjectRailCommand[]) => void;
}

const RailConfigContext = createContext<RailConfigContextValue | null>(null);

export function RailConfigProvider({ children }: { children: ReactNode }) {
  const { currentMemberId } = useIdentity();
  const [taskFavorites, setTaskFavoritesState] = useState(() =>
    readRailFavorites("task", currentMemberId),
  );
  const [projectFavorites, setProjectFavoritesState] = useState(() =>
    readRailFavorites("project", currentMemberId),
  );

  // Re-read favorites whenever the active member changes so switching the
  // local member reloads that member's own rail configuration rather than
  // keeping the previous member's favorites in memory.
  useEffect(() => {
    setTaskFavoritesState(readRailFavorites("task", currentMemberId));
    setProjectFavoritesState(readRailFavorites("project", currentMemberId));
  }, [currentMemberId]);

  const setTaskFavorites = useCallback(
    (favorites: readonly TaskRailCommand[]) => {
      setTaskFavoritesState(favorites);
      writeRailFavorites("task", favorites, currentMemberId);
    },
    [currentMemberId],
  );
  const setProjectFavorites = useCallback(
    (favorites: readonly ProjectRailCommand[]) => {
      setProjectFavoritesState(favorites);
      writeRailFavorites("project", favorites, currentMemberId);
    },
    [currentMemberId],
  );

  const value = useMemo(
    () => ({
      taskFavorites,
      projectFavorites,
      setTaskFavorites,
      setProjectFavorites,
    }),
    [taskFavorites, projectFavorites, setTaskFavorites, setProjectFavorites],
  );
  return (
    <RailConfigContext.Provider value={value}>
      {children}
    </RailConfigContext.Provider>
  );
}

export function useRailConfig(): RailConfigContextValue {
  const context = useContext(RailConfigContext);
  if (!context) {
    throw new Error("useRailConfig must be used within a RailConfigProvider");
  }
  return context;
}
