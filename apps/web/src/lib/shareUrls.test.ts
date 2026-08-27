import { describe, expect, it } from "vitest";
import { buildProjectShareUrl, buildTaskShareUrl } from "./shareUrls";

describe("share URLs", () => {
  it("keeps a deployment sub-path while building project hash URLs", () => {
    expect(buildProjectShareUrl(42, "https://example.test/machbar/")).toBe(
      "https://example.test/machbar/#/projekte/42",
    );
  });

  it("builds a hash URL for the planned task route", () => {
    expect(buildTaskShareUrl(9, "https://example.test/machbar/index.html")).toBe(
      "https://example.test/machbar/index.html#/aufgaben/9",
    );
  });
});
