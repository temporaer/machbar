import { describe, expect, it } from "vitest";
import { followUpEntryHeader } from "./WaitingFollowUpSheet";

describe("followUpEntryHeader", () => {
  it("serializes the generated follow-up timestamp in the selected locale", () => {
    const now = new Date(2026, 7, 27, 18, 5);
    const timestamp = new Intl.DateTimeFormat("en-US", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(now);

    expect(followUpEntryHeader("Mira", now, "en")).toBe(
      `[${timestamp} · Mira]`,
    );
  });
});
