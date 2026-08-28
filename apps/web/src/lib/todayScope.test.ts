import { afterEach, describe, expect, it, vi } from "vitest";
import { readTodayScope, writeTodayScope } from "./todayScope";

describe("todayScope", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("defaults invalid stored values to mine", () => {
    window.sessionStorage.setItem("machbar:today-scope", "someone-else");
    expect(readTodayScope()).toBe("mine");
  });

  it("keeps working when session storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(readTodayScope()).toBe("mine");
    expect(() => writeTodayScope("all")).not.toThrow();
  });
});
