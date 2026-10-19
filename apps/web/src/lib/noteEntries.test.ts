import { describe, expect, it } from "vitest";
import { notePreview, sliceNoteTokens, stampNote } from "./noteEntries";

describe("portable note entries", () => {
  it("recognizes only complete instants and leaves bracketed prose and fenced examples alone", () => {
    const value =
      "Background\n\n[2026-10-19T15:21:00.000Z · Hannes]\nLatest **outcome**\n\n[ordinary prose]\n\n```\n[2026-10-19T15:22:00Z · Example]\n```";
    const preview = notePreview(value);
    expect(preview.entry).toMatchObject({
      instant: "2026-10-19T15:21:00.000Z",
      author: "Hannes",
    });
    expect(preview.tokens.map((t) => t.text).join("")).toContain(
      "[ordinary prose]",
    );
    expect(preview.tokens.map((t) => t.text).join("")).toContain("Example");
    expect(
      notePreview("[2026-10-19T15:21:00 · Hannes]\nplain").entry,
    ).toBeUndefined();
  });
  it("stamps UI additions once without changing existing stamped content", () => {
    const entry = stampNote(
      "  Outcome  ",
      "Hannes",
      new Date("2026-10-19T15:21:00Z"),
    );
    expect(entry).toBe("[2026-10-19T15:21:00.000Z · Hannes]\nOutcome");
    expect(stampNote(entry, "Sarah")).toBe(entry);
    expect(stampNote("  ", "Sarah")).toBe("");
  });
  it("keeps links and the real ending without attachment markup or orphaned metadata", () => {
    const value =
      "Old background\n\n[2026-10-19T15:21:00Z · Hannes]\n" +
      "long paragraph ".repeat(80) +
      "[next step](https://example.com)\n\n![Scan](paperless:12)";
    const preview = notePreview(value);
    const tokens = sliceNoteTokens(
      preview.tokens,
      preview.tokens.map((t) => t.text).join("").length - 12,
    );
    expect(tokens.map((t) => t.text).join("")).toContain("next step");
    expect(tokens.find((t) => t.href)?.href).toBe("https://example.com");
    expect(preview.entry?.author).toBe("Hannes");
    expect(preview.tokens.map((t) => t.text).join("")).not.toMatch(
      /paperless|\*\*|2026-10-19/,
    );
    expect(notePreview("![Scan](paperless:12)").tokens).toEqual([]);
  });
});

describe("GFM card tails", () => {
  it("uses readable task-list and strikethrough text", () => {
    const text = notePreview("- [x] ~~finished~~\n- [ ] remaining")
      .tokens.map((t) => t.text)
      .join("");
    expect(text).toContain("finished");
    expect(text).toContain("remaining");
    expect(text).not.toMatch(/\[x\]|\[ \]|~~/);
  });
  it("resolves document-wide references before slicing the tail", () => {
    const preview = notePreview(
      "[doc]: https://example.com\n\n[2026-10-19T15:21:00Z · Hannes]\n[latest][doc]",
    );
    expect(preview.tokens.find((t) => t.text === "latest")?.href).toBe(
      "https://example.com",
    );
    expect(preview.entry?.author).toBe("Hannes");
  });
  it("retains GFM autolinks and applies the same URL policy", () => {
    const preview = notePreview("www.example.com [unsafe](javascript:alert)");
    expect(preview.tokens.find((t) => t.text === "www.example.com")?.href).toBe(
      "http://www.example.com",
    );
    expect(
      preview.tokens.find((t) => t.text === "unsafe")?.href,
    ).toBeUndefined();
  });
});
