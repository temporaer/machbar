import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  SwipeSettingsProvider,
  primarySwipeActions,
  readStoredPrimarySwipeAction,
  useSwipeSettings,
} from "./swipeSettings";

const STORAGE_KEY = "machbar:primary-swipe-action";

describe("swipeSettings", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to 'complete' (Erledigen/Wieder öffnen) when nothing is stored", () => {
    expect(readStoredPrimarySwipeAction()).toBe("complete");
  });

  it("reads a previously persisted valid choice from localStorage", () => {
    window.localStorage.setItem(STORAGE_KEY, "waiting");
    expect(readStoredPrimarySwipeAction()).toBe("complete");
  });

  it("falls back to the default for garbage/unknown stored values", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-a-real-action");
    expect(readStoredPrimarySwipeAction()).toBe("complete");
  });

  it("exposes exactly the four documented options", () => {
    expect(primarySwipeActions).toEqual(["complete", "someday", "cancel"]);
  });

  it("persists a changed setting to localStorage so it survives a reload", () => {
    const { result } = renderHook(() => useSwipeSettings(), { wrapper: SwipeSettingsProvider });

    expect(result.current.primarySwipeAction).toBe("complete");

    act(() => result.current.setPrimarySwipeAction("someday"));

    expect(result.current.primarySwipeAction).toBe("someday");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("someday");

    // A fresh provider (simulating a reload) must pick up the persisted value.
    const { result: reloaded } = renderHook(() => useSwipeSettings(), { wrapper: SwipeSettingsProvider });
    expect(reloaded.current.primarySwipeAction).toBe("someday");
  });

  it("throws when used outside of the provider", () => {
    expect(() => renderHook(() => useSwipeSettings())).toThrow(
      "useSwipeSettings must be used within a SwipeSettingsProvider",
    );
  });
});
