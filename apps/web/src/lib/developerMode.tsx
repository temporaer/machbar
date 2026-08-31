import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";

export const DEVELOPER_MODE_STORAGE_KEY = "machbar:developer-mode";

function readStoredDeveloperMode(): boolean {
  if (typeof window === "undefined") return false;

  try {
    return window.localStorage.getItem(DEVELOPER_MODE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

interface DeveloperModeContextValue {
  developerMode: boolean;
  setDeveloperMode: (enabled: boolean) => void;
}

const DeveloperModeContext = createContext<DeveloperModeContextValue | null>(null);

export function DeveloperModeProvider({ children }: { children: ReactNode }) {
  const [developerMode, setDeveloperModeState] = useState(readStoredDeveloperMode);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== DEVELOPER_MODE_STORAGE_KEY && event.key !== null) return;
      setDeveloperModeState(event.newValue === "true");
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setDeveloperMode = useCallback((enabled: boolean) => {
    setDeveloperModeState(enabled);
    try {
      window.localStorage.setItem(DEVELOPER_MODE_STORAGE_KEY, String(enabled));
    } catch {
      // The in-memory preference still works when storage is unavailable.
    }
  }, []);

  const value = useMemo(
    () => ({ developerMode, setDeveloperMode }),
    [developerMode, setDeveloperMode],
  );

  return (
    <DeveloperModeContext.Provider value={value}>
      {children}
    </DeveloperModeContext.Provider>
  );
}

export function useDeveloperMode(): DeveloperModeContextValue {
  const context = useContext(DeveloperModeContext);
  if (!context) {
    throw new Error("useDeveloperMode must be used within a DeveloperModeProvider");
  }
  return context;
}

export { readStoredDeveloperMode };
