import { describe, expect, it } from "vitest";
import {
  extractCaptionHints,
  removeCaptionHintSpans,
  strongestCaptionHints,
  type TemporalCaptionHint,
} from "./captionHints";
import { makeMember, makePhysicalContext, makeTag } from "../test/fixtures";

const referenceDate = new Date(2026, 8, 14, 12);

function temporal(text: string, locale: "de" | "en" = "de") {
  return extractCaptionHints(text, { locale, referenceDate }).filter(
    (hint): hint is TemporalCaptionHint => hint.kind === "temporal",
  );
}

describe("captionHints", () => {
  it.each([
    ["heute", "2026-09-14"],
    ["morgen früh", "2026-09-15"],
    ["übermorgen", "2026-09-16"],
    ["fr 15", "2026-09-18"],
    ["fr 15:30", "2026-09-18"],
    ["18.9 14", "2026-09-18"],
    ["in 2 tagen", "2026-09-16"],
    ["in 2 wochen", "2026-09-28"],
    ["nächste woche", "2026-09-21"],
  ])("extracts German mobile date shorthand %s", (text, expected) => {
    expect(temporal(text)[0]?.date).toBe(expected);
  });

  it.each([
    ["today", "2026-09-14"],
    ["tomorrow", "2026-09-15"],
    ["tonight", "2026-09-14"],
    ["fri 3pm", "2026-09-18"],
    ["fri 15:30", "2026-09-18"],
    ["9/18", "2026-09-18"],
    ["in 2 days", "2026-09-16"],
    ["in 2 weeks", "2026-09-28"],
    ["next week", "2026-09-21"],
  ])("extracts English mobile date shorthand %s", (text, expected) => {
    expect(temporal(text, "en")[0]?.date).toBe(expected);
  });

  it("keeps multiple dates and ranks their semantics", () => {
    const hints = temporal("Angebot bis Freitag prüfen, Montag nochmal nachhaken");
    expect(hints).toEqual([
      expect.objectContaining({ date: "2026-09-18", semantic: "dueDate" }),
      expect.objectContaining({ date: "2026-09-21", semantic: "followUp" }),
    ]);
  });

  it("anchors relative dates to the supplied creation date", () => {
    const createdAt = new Date(2025, 11, 30, 12);
    const hints = extractCaptionHints("in 2 tagen anrufen", {
      locale: "de",
      referenceDate: createdAt,
    });
    expect(hints[0]).toEqual(
      expect.objectContaining({ kind: "temporal", date: "2026-01-01" }),
    );
  });

  it("does not turn unrelated bare numbers into dates", () => {
    expect(temporal("15 Lampen kaufen")).toEqual([]);
  });

  it("does not treat locale-mismatched or ambiguous weekday words as dates", () => {
    expect(temporal("do laundry", "en")).toEqual([]);
    expect(temporal("so machen", "de")).toEqual([]);
  });

  it("matches explicit and plain known entities without inventing values", () => {
    const anna = makeMember({ id: 1, name: "Anna" });
    const heizung = makeTag({ id: 2, name: "Heizung" });
    const baumarkt = makePhysicalContext({ id: 3, name: "Baumarkt" });
    const hints = extractCaptionHints(
      "für Anna #heizung im Baumarkt Schrauben holen",
      {
        locale: "de",
        referenceDate,
        members: [anna],
        tags: [heizung],
        contexts: [baumarkt, makePhysicalContext({ id: 4, name: "Büro", active: false })],
      },
    );
    expect(hints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "member", member: anna, source: "für Anna" }),
        expect.objectContaining({ kind: "tag", tag: heizung, source: "#heizung" }),
        expect.objectContaining({ kind: "context", context: baumarkt, source: "Baumarkt" }),
      ]),
    );
    expect(hints.some((hint) => hint.kind === "context" && hint.context.id === 4)).toBe(false);
  });

  it.each([
    ["auf Peter warten", "Peter"],
    ["Rückmeldung von Vanessa", "Vanessa"],
    ["Peter fragen und warten", "Peter"],
    ["wait for Peter", "Peter"],
    ["waiting for Vanessa", "Vanessa"],
    ["response from Peter", "Peter"],
  ])("extracts waiting text from %s", (text, expected) => {
    const hint = extractCaptionHints(text, {
      locale: text.includes("for") || text.includes("from") ? "en" : "de",
      referenceDate,
      members: [
        makeMember({ id: 1, name: "Peter" }),
        makeMember({ id: 2, name: "Vanessa" }),
      ],
    }).find((candidate) => candidate.kind === "waiting");
    expect(hint).toEqual(expect.objectContaining({ waitingFor: expected }));
  });

  it("caps suggestions by strongest rank", () => {
    const hints = extractCaptionHints("Anna Anke Anne Anja", {
      locale: "de",
      referenceDate,
      members: [
        makeMember({ id: 1, name: "Anna" }),
        makeMember({ id: 2, name: "Anke" }),
        makeMember({ id: 3, name: "Anne" }),
        makeMember({ id: 4, name: "Anja" }),
      ],
    }).filter((hint) => hint.kind === "member");
    expect(strongestCaptionHints(hints)).toHaveLength(3);
  });

  it("allows conservative prefix matching against known entities", () => {
    const context = makePhysicalContext({ id: 5, name: "Baumarkt" });
    const hint = extractCaptionHints("Baumark Schrauben holen", {
      locale: "de",
      referenceDate,
      contexts: [context],
    }).find((candidate) => candidate.kind === "context");
    expect(hint).toEqual(expect.objectContaining({ context, source: "Baumark" }));
  });

  it("does not match one-character words as entity prefixes", () => {
    const member = makeMember({ id: 6, name: "Anna" });
    const hints = extractCaptionHints("A report", {
      locale: "en",
      referenceDate,
      members: [member],
    });
    expect(hints.filter((hint) => hint.kind === "member")).toEqual([]);
  });

  it("removes only accepted spans and normalizes punctuation", () => {
    const text = "Angebot bis Freitag prüfen, Montag nochmal nachhaken";
    const hints = temporal(text);
    expect(removeCaptionHintSpans(text, hints.map((hint) => hint.removalSpan))).toBe(
      "Angebot prüfen",
    );
    expect(removeCaptionHintSpans("@Anna", [{ start: 0, end: 5 }])).toBe("@Anna");
  });
});
