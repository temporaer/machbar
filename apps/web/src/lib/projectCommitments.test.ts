import { describe, expect, it } from "vitest";
import { makeProject } from "../test/fixtures";
import { hasProjectProgressPath } from "./projectCommitments";

describe("project commitments", () => {
  it("uses the backend's canonical healthy-waiting readiness", () => {
    const project = makeProject({
      nextAction: null,
      waitingUntil: "2099-01-01",
      activationReadiness: {
        ready: false,
        hasDriver: false,
        hasViableProgressPath: false,
        hasHealthyFutureWaiting: true,
      },
    });

    expect(hasProjectProgressPath(project)).toBe(true);
  });

  it("does not infer readiness from a future wait display date", () => {
    const project = makeProject({
      nextAction: null,
      waitingUntil: "2099-01-01",
    });

    expect(hasProjectProgressPath(project)).toBe(false);
  });
});
