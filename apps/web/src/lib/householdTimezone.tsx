import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  DEFAULT_HOUSEHOLD_TIMEZONE,
} from "@machbar/shared";
import { api } from "./api";

interface HouseholdTimezoneContextValue {
  timezone: string;
  loaded: boolean;
  setTimezone: (timezone: string) => void;
}

const defaultValue: HouseholdTimezoneContextValue = {
  timezone: DEFAULT_HOUSEHOLD_TIMEZONE,
  loaded: true,
  setTimezone: () => {},
};

const HouseholdTimezoneContext =
  createContext<HouseholdTimezoneContextValue>(defaultValue);

export function HouseholdTimezoneProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const [timezone, setTimezone] = useState<string>(DEFAULT_HOUSEHOLD_TIMEZONE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setLoaded(true);
      return;
    }
    setLoaded(false);
    let active = true;
    void api
      .getHouseholdTimezone()
      .then((settings) => {
        if (active) setTimezone(settings.timezone);
      })
      .catch(() => {
        if (active) setTimezone(DEFAULT_HOUSEHOLD_TIMEZONE);
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  const value = useMemo(
    () => ({ timezone, loaded, setTimezone }),
    [timezone, loaded],
  );
  return (
    <HouseholdTimezoneContext.Provider value={value}>
      {children}
    </HouseholdTimezoneContext.Provider>
  );
}

export function useHouseholdTimezone(): HouseholdTimezoneContextValue {
  return useContext(HouseholdTimezoneContext);
}
