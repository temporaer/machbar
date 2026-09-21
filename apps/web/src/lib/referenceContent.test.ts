import { describe, expect, it } from "vitest";
import { parseReferenceContent } from "./referenceContent";

describe("parseReferenceContent", () => {
  it("finds a bare URL and derives its hostname as the label", () => {
    const parsed = parseReferenceContent("https://camping-wang.ch/\n\nDirekt am See");
    expect(parsed.primaryWebLink).toEqual({
      url: "https://camping-wang.ch/",
      label: "camping-wang.ch",
    });
    expect(parsed.remainingText).toBe("Direkt am See");
  });

  it("finds a Markdown link and uses its label", () => {
    const parsed = parseReferenceContent(
      "[Useful title](https://example.com)\n\nSome notes",
    );
    expect(parsed.primaryWebLink).toEqual({
      url: "https://example.com",
      label: "Useful title",
    });
    expect(parsed.remainingText).toBe("Some notes");
  });

  it("uses the first suitable http(s) link when multiple links exist", () => {
    const parsed = parseReferenceContent(
      "See [first](https://first.example) and [second](https://second.example)",
    );
    expect(parsed.primaryWebLink?.url).toBe("https://first.example");
  });

  it("extracts Paperless attachments separately from the primary web link", () => {
    const parsed = parseReferenceContent(
      "https://camping-wang.ch/\n\n[Preisliste](paperless:7)\n\nGute Lage",
    );
    expect(parsed.primaryWebLink?.url).toBe("https://camping-wang.ch/");
    expect(parsed.paperlessAttachments).toEqual([
      { id: 7, label: "Preisliste", kind: "document" },
    ]);
    expect(parsed.remainingText).toBe("Gute Lage");
  });

  it("returns no primary link and full remaining text when there is no URL", () => {
    const parsed = parseReferenceContent("Just some plain notes.");
    expect(parsed.primaryWebLink).toBeNull();
    expect(parsed.paperlessAttachments).toEqual([]);
    expect(parsed.remainingText).toBe("Just some plain notes.");
  });

  it("never treats a paperless: link as the primary web link", () => {
    const parsed = parseReferenceContent("[Doc](paperless:3)");
    expect(parsed.primaryWebLink).toBeNull();
    expect(parsed.paperlessAttachments).toEqual([
      { id: 3, label: "Doc", kind: "document" },
    ]);
  });
});
