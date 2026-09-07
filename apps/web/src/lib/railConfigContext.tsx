import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ProjectRailCommand, TaskRailCommand } from "./commands";
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
  const [taskFavorites, setTaskFavoritesState] = useState(() =>
    readRailFavorites("task"),
  );
  const [projectFavorites, setProjectFavoritesState] = useState(() =>
    readRailFavorites("project"),
  );

  const setTaskFavorites = useCallback(
    (favorites: readonly TaskRailCommand[]) => {
      setTaskFavoritesState(favorites);
      writeRailFavorites("task", favorites);
    },
    [],
  );
  const setProjectFavorites = useCallback(
    (favorites: readonly ProjectRailCommand[]) => {
      setProjectFavoritesState(favorites);
      writeRailFavorites("project", favorites);
    },
    [],
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
