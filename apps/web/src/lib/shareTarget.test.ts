import { describe, expect, it } from "vitest";
import {
  appendTextBlock,
  parseWebShareTarget,
  shareTargetToCaptureDraft,
  shareTargetToTextBlock,
} from "./shareTarget";

describe("share target helpers", () => {
  it("parses the standard Web Share Target GET parameters", () => {
    expect(parseWebShareTarget("?title=Angebot+lesen&text=Bitte+pr%C3%BCfen&url=https%3A%2F%2Fexample.test")).toEqual({
      title: "Angebot lesen",
      text: "Bitte prüfen",
      url: "https://example.test",
      files: [],
    });
  });

  it("uses a page title and keeps its URL as notes", () => {
    expect(
      shareTargetToCaptureDraft({
        title: "Beispielseite",
        text: "",
        url: "https://example.test/article",
        files: [],
      }),
    ).toEqual({
      title: "Beispielseite",
      notes: "https://example.test/article",
    });
  });

  it("uses short plain text as the capture title", () => {
    expect(shareTargetToCaptureDraft({ title: "", text: "Milch kaufen", url: "", files: [] })).toEqual({
      title: "Milch kaufen",
      notes: "",
    });
  });

  it("uses a localized fallback title for an empty English share", () => {
    expect(
      shareTargetToCaptureDraft({ title: "", text: "", url: "", files: [] }, "en"),
    ).toEqual({
      title: "Shared content",
      notes: "",
    });
  });

  it("keeps long shared text as notes and derives a concise title", () => {
    const text =
      "Das ist eine längere Beschreibung, die als Notiz erhalten bleiben soll, statt als überlanger Aufgabentitel zu enden.";
    expect(shareTargetToCaptureDraft({ title: "", text, url: "", files: [] })).toEqual({
      title: "Das ist eine längere Beschreibung, die als Notiz erhalten bleiben soll, statt…",
      notes: text,
    });
  });

  it("separates text and a URL with a blank line", () => {
    const target = { title: "", text: "Termin abstimmen", url: "https://example.test/calendar", files: [] };
    expect(shareTargetToCaptureDraft(target)).toEqual({
      title: "Termin abstimmen",
      notes: "https://example.test/calendar",
    });
    expect(shareTargetToTextBlock(target)).toBe(
      "Termin abstimmen\n\nhttps://example.test/calendar",
    );
  });

  it("uses exactly one blank line when appending non-empty text", () => {
    expect(appendTextBlock("Bestehende Notiz\n\n", "\nGeteilter Inhalt\n")).toBe(
      "Bestehende Notiz\n\nGeteilter Inhalt",
    );
    expect(appendTextBlock("", " Inhalt ")).toBe("Inhalt");
    expect(appendTextBlock("Inhalt", "")).toBe("Inhalt");
  });

  it("preserves Calendar metadata and time as generic shared content", () => {
    const target = {
      title: "Elternabend",
      text:
        "15. Sept. • 19:00–21:00 • Details ansehen\nhttps://calendar.app.google/abc123",
      url: "",
      files: [],
    };
    expect(shareTargetToCaptureDraft(target)).toEqual({
      title: "Elternabend",
      notes:
        "15. Sept. • 19:00–21:00 • Details ansehen\nhttps://calendar.app.google/abc123",
    });
    expect(shareTargetToTextBlock(target)).toBe(
      "Elternabend\n\n15. Sept. • 19:00–21:00 • Details ansehen\nhttps://calendar.app.google/abc123",
    );
  });

  it("uses the first filename as the draft title for a file-only share", () => {
    const file = new File(["scan"], "receipt.pdf", {
      type: "application/pdf",
    });
    expect(
      shareTargetToCaptureDraft({
        title: "",
        text: "",
        url: "",
        files: [file],
      }),
    ).toEqual({
      title: "receipt.pdf",
      notes: "",
    });
  });
});
