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
    });
  });

  it("uses a page title and keeps its URL as notes", () => {
    expect(
      shareTargetToCaptureDraft({
        title: "Beispielseite",
        text: "",
        url: "https://example.test/article",
      }),
    ).toEqual({
      title: "Beispielseite",
      notes: "https://example.test/article",
    });
  });

  it("uses short plain text as the capture title", () => {
    expect(shareTargetToCaptureDraft({ title: "", text: "Milch kaufen", url: "" })).toEqual({
      title: "Milch kaufen",
      notes: "",
    });
  });

  it("keeps long shared text as notes and derives a concise title", () => {
    const text =
      "Das ist eine längere Beschreibung, die als Notiz erhalten bleiben soll, statt als überlanger Aufgabentitel zu enden.";
    expect(shareTargetToCaptureDraft({ title: "", text, url: "" })).toEqual({
      title: "Das ist eine längere Beschreibung, die als Notiz erhalten bleiben soll, statt…",
      notes: text,
    });
  });

  it("separates text and a URL with a blank line", () => {
    const target = { title: "", text: "Termin abstimmen", url: "https://example.test/calendar" };
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
});
