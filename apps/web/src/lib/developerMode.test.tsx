import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEVELOPER_MODE_STORAGE_KEY,
  DeveloperModeProvider,
  readStoredDeveloperMode,
  useDeveloperMode,
} from "./developerMode";

describe("developerMode", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to disabled", () => {
    expect(readStoredDeveloperMode()).toBe(false);
  });

  it("persists the device-local preference", () => {
    const { result } = renderHook(() => useDeveloperMode(), {
      wrapper: DeveloperModeProvider,
    });

    act(() => result.current.setDeveloperMode(true));

    expect(result.current.developerMode).toBe(true);
    expect(window.localStorage.getItem(DEVELOPER_MODE_STORAGE_KEY)).toBe("true");

    const { result: reloaded } = renderHook(() => useDeveloperMode(), {
      wrapper: DeveloperModeProvider,
    });
    expect(reloaded.current.developerMode).toBe(true);
  });

  it("throws outside its provider", () => {
    expect(() => renderHook(() => useDeveloperMode())).toThrow(
      "useDeveloperMode must be used within a DeveloperModeProvider",
    );
  });
});
