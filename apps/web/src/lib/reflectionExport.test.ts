import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReflectionBriefing } from "@machbar/shared";
import { buildReflectionExportText, downloadReflectionExport } from "./reflectionExport";

afterEach(() => vi.restoreAllMocks());

const briefing = {
  subject: { id: 7, name: "Mira" },
  markdown: "# Factual report\n\nRecorded outcomes: 2",
} as ReflectionBriefing;

describe("reflection export", () => {
  it("keeps coaching instructions separate from the deterministic briefing", () => {
    expect(buildReflectionExportText(briefing, "Ask one question at a time.", { coaching: "Coach instructions", briefing: "Factual briefing" })).toBe(
      "## Coach instructions\n\nAsk one question at a time.\n\n---\n\n## Factual briefing\n\n# Factual report\n\nRecorded outcomes: 2",
    );
  });

  it.each([
    ["markdown", "machbar-reflexion.md", "text/markdown;charset=utf-8"],
    ["text", "machbar-reflexion.txt", "text/plain;charset=utf-8"],
  ] as const)("downloads a user-requested %s file", (format, filename, mimeType) => {
    const createObjectURL = vi.fn((_blob: Blob | MediaSource) => "blob:reflection");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    let downloadedName: string | undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedName = this.download;
    });
    const timeout = vi.spyOn(window, "setTimeout").mockImplementation((handler) => {
      if (typeof handler === "function") handler();
      return 1 as unknown as ReturnType<typeof window.setTimeout>;
    });

    downloadReflectionExport("complete preview", format);

    const [blob] = createObjectURL.mock.calls[0] ?? [];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob).toMatchObject({ type: mimeType });
    expect(click).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:reflection");
    expect(downloadedName).toBe(filename);
  });
});
