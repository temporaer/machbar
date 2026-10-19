import { describe, expect, it } from "vitest";
import {
  noteEntries,
  notePreview,
  sliceNoteTokens,
  stampNote,
} from "./noteEntries";

describe("portable note entries", () => {
  it("recognizes only complete instants and leaves bracketed prose and fenced examples alone", () => {
    const value =
      "Background\n\n[2026-10-19T15:21:00.000Z · Hannes]\nLatest **outcome**\n\n[ordinary prose]\n\n```\n[2026-10-19T15:22:00Z · Example]\n```";
    const entries = noteEntries(value);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      instant: "2026-10-19T15:21:00.000Z",
      author: "Hannes",
    });
    expect(entries[1]!.content).toContain("[ordinary prose]");
    expect(entries[1]!.content).toContain("Example");
    expect(
      noteEntries("[2026-10-19T15:21:00 · Hannes]\nplain")[0]!.instant,
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
