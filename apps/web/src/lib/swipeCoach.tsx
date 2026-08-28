import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

export const SWIPE_COACH_STORAGE_KEY = "machbar:swipe-coach:v1";
const AUTO_DISMISS_MS = 6000;

interface SwipeCoachContextValue {
  activeId: string | null;
  reducedMotion: boolean;
  register: (id: string) => () => void;
  dismiss: () => void;
}

const SwipeCoachContext = createContext<SwipeCoachContextValue | null>(null);
const inactiveSwipeCoach: SwipeCoachContextValue = {
  activeId: null,
  reducedMotion: false,
  register: () => () => undefined,
  dismiss: () => undefined,
};

function readMediaQuery(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

function readSeen(): boolean {
  try {
    return window.localStorage.getItem(SWIPE_COACH_STORAGE_KEY) === "seen";
  } catch {
    return false;
  }
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => readMediaQuery(query));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [query]);

  return matches;
}

export function SwipeCoachProvider({ children }: { children: ReactNode }) {
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const registrations = useRef(new Set<string>());
  const [seen, setSeen] = useState(readSeen);
  const [activeId, setActiveId] = useState<string | null>(null);

  const dismiss = useCallback(() => {
    setSeen(true);
    setActiveId(null);
    try {
      window.localStorage.setItem(SWIPE_COACH_STORAGE_KEY, "seen");
    } catch {
      // The in-memory dismissal still prevents repetition during this session.
    }
  }, []);

  const register = useCallback(
    (id: string) => {
      registrations.current.add(id);
      if (!seen && coarsePointer) {
        setActiveId((current) => current ?? id);
      }

      return () => {
        registrations.current.delete(id);
        setActiveId((current) => {
          if (current !== id) return current;
          return registrations.current.values().next().value ?? null;
        });
      };
    },
    [coarsePointer, seen],
  );

  useEffect(() => {
    if (seen || !coarsePointer) {
      setActiveId(null);
      return;
    }
    setActiveId((current) => current ?? registrations.current.values().next().value ?? null);
  }, [coarsePointer, seen]);

  useEffect(() => {
    if (activeId === null) return;
    const timeout = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeout);
  }, [activeId, dismiss]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== SWIPE_COACH_STORAGE_KEY && event.key !== null) return;
      const nextSeen = event.newValue === "seen";
      setSeen(nextSeen);
      if (nextSeen) setActiveId(null);
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const value = useMemo<SwipeCoachContextValue>(
    () => ({ activeId, reducedMotion, register, dismiss }),
    [activeId, dismiss, reducedMotion, register],
  );

  return <SwipeCoachContext.Provider value={value}>{children}</SwipeCoachContext.Provider>;
}

export function useSwipeCoach(id: string, eligible = true) {
  const context = useContext(SwipeCoachContext) ?? inactiveSwipeCoach;
  const { activeId, reducedMotion, register, dismiss } = context;

  useEffect(() => {
    if (!eligible) return undefined;
    return register(id);
  }, [eligible, id, register]);

  const active = eligible && activeId === id;
  return {
    active,
    animate: active && !reducedMotion,
    dismiss,
  };
}
