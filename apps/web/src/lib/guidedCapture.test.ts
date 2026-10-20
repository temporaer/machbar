import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCatalog } from "./locale";
import {
  emptyReflectionDeck, guidedCaptureCatalog, nextReflectionCard,
  readReflectionDeck, reflectionDeckStorageKey, visitReflectionArea, writeReflectionDeck,
} from "./guidedCapture";

const areas = guidedCaptureCatalog(getCatalog("de")).flatMap((group) => group.areas);
function seededRandom(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe("balanced reflection deck", () => {
  it.each([1, 42, 739])("covers every area once per cycle with mixed, varying order (seed %i)", (seed) => {
    const random = seededRandom(seed);
    let deck = emptyReflectionDeck();
    const cycles: string[][] = [];
    for (let cycle = 0; cycle < 10; cycle++) {
      const ids: string[] = [];
      for (let index = 0; index < areas.length; index++) {
        const remaining = areas.filter((area) => !ids.includes(area.id));
        const previous = areas.find((area) => area.id === deck.cards.at(-1)?.areaId);
        deck = nextReflectionCard(deck, areas, random);
        const current = deck.cards[deck.index]!;
        ids.push(current.areaId);
        if (remaining.some((area) => area.tone !== previous?.tone)) {
          expect(areas.find((area) => area.id === current.areaId)?.tone).not.toBe(previous?.tone);
        }
      }
      expect(new Set(ids)).toEqual(new Set(areas.map((area) => area.id)));
      cycles.push(ids);
    }
    expect(new Set(cycles.map((cycle) => cycle.join(","))).size).toBeGreaterThan(1);
    expect(new Set(cycles.map((cycle) => cycle[0])).size).toBeGreaterThan(1);
    expect(deck.cards).toHaveLength(48);
  });

  it("uses all perspectives before repeating and avoids repeats across pool boundaries", () => {
    let deck = emptyReflectionDeck();
    const random = seededRandom(9);
    const prompts: Record<string, string[]> = {};
    for (let index = 0; index < 16 * 7; index++) {
      deck = nextReflectionCard(deck, areas, random);
      const card = deck.cards[deck.index]!;
      const previous = prompts[card.areaId] ?? [];
      expect(card.promptId).not.toBe(previous.at(-1));
      prompts[card.areaId] = [...previous, card.promptId];
    }
    for (const ids of Object.values(prompts)) {
      expect(new Set(ids.slice(0, 3)).size).toBe(3);
      expect(new Set(ids.slice(3, 6)).size).toBe(3);
    }
  });

  it("handles a single area/question and an empty catalog", () => {
    const single = [{ id: "home", tone: "home", prompts: { only: "One question?" } }];
    let deck = emptyReflectionDeck();
    for (let index = 0; index < 5; index++) deck = nextReflectionCard(deck, single, () => 0);
    expect(deck.cards.map((card) => card.promptId)).toEqual(Array(5).fill("only"));
    expect(nextReflectionCard(emptyReflectionDeck(), [], () => 0)).toEqual(emptyReflectionDeck());
  });

  it("traverses generated history before drawing and leaves previous cards immutable", () => {
    const random = seededRandom(7);
    let deck = emptyReflectionDeck();
    for (let index = 0; index < 6; index++) deck = nextReflectionCard(deck, areas, random);
    const cards = [...deck.cards];
    const noDraw = vi.fn(() => { throw new Error("History must not draw"); });
    deck = { ...deck, index: 1 };
    for (let index = 2; index < 6; index++) {
      deck = nextReflectionCard(deck, areas, noDraw);
      expect(deck.cards[deck.index]).toEqual(cards[index]);
    }
    expect(deck.cards).toEqual(cards);
    expect(noDraw).not.toHaveBeenCalled();
  });

  it("appends an unseen picker area, reuses visited cards, and ignores invalid IDs", () => {
    let deck = visitReflectionArea(emptyReflectionDeck(), areas, "learning", () => 0);
    deck = visitReflectionArea(deck, areas, "home", () => 0);
    expect(deck.cards.map((card) => card.areaId)).toEqual(["learning", "home"]);
    expect(deck.seen).toEqual(["learning", "home"]);
    const history = deck.cards;
    deck = visitReflectionArea(deck, areas, "learning", () => 0);
    expect(deck.index).toBe(0);
    expect(nextReflectionCard(deck, areas).cards[1]).toEqual(history[1]);
    expect(visitReflectionArea(deck, areas, "learning")).toBe(deck);
    expect(visitReflectionArea(deck, areas, "unknown")).toBe(deck);
    // New picks from Back append after the existing frontier; none is discarded.
    deck = visitReflectionArea(deck, areas, "travel", () => 0);
    expect(deck.cards.slice(0, 2)).toEqual(history);
    expect(deck.cards[deck.index - 1]?.areaId).toBe("home");
    for (let index = 3; index < 16; index++) deck = nextReflectionCard(deck, areas, () => 0);
    expect(new Set(deck.cards.map((card) => card.areaId)).size).toBe(16);
  });

  it("revisits the latest retained card for an area and continues from there", () => {
    let deck = emptyReflectionDeck();
    const random = seededRandom(2026);
    for (let index = 0; index < 3 * areas.length; index++) {
      deck = nextReflectionCard(deck, areas, random);
    }

    const areaId = "family";
    const occurrences = deck.cards.flatMap((card, index) =>
      card.areaId === areaId ? [index] : [],
    );
    const latestIndex = occurrences.at(-1)!;
    expect(occurrences).toHaveLength(3);
    expect(latestIndex).toBeLessThan(deck.cards.length - 1);

    const revisited = visitReflectionArea(deck, areas, areaId);
    expect(revisited.index).toBe(latestIndex);
    expect(revisited.cards[revisited.index]).toEqual(deck.cards[latestIndex]);

    const next = nextReflectionCard(revisited, areas);
    expect(next.index).toBe(latestIndex + 1);
    expect(next.cards[next.index]).toEqual(deck.cards[latestIndex + 1]);
  });

  it("keeps draft-bearing cards reachable while bounding ordinary history", () => {
    let deck = nextReflectionCard(emptyReflectionDeck(), areas, () => 0);
    const first = deck.cards[0]!;
    for (let index = 0; index < 80; index++) deck = nextReflectionCard(deck, areas, () => 0, [first.id]);
    expect(deck.cards).toContainEqual(first);
    expect(deck.cards.length).toBeLessThanOrEqual(49);
    deck = nextReflectionCard(deck, areas, () => 0);
    expect(deck.cards).toHaveLength(48);
  });
});

describe("member-local reflection rotation", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("restores a bounded history/current question and separates members", () => {
    let deck = emptyReflectionDeck();
    for (let index = 0; index < 40; index++) deck = nextReflectionCard(deck, areas, seededRandom(index));
    deck = { ...deck, index: 18 };
    writeReflectionDeck(1, deck);
    expect(readReflectionDeck(1, areas)).toEqual(deck);
    expect(readReflectionDeck(2, areas)).toEqual(emptyReflectionDeck());
    expect(readReflectionDeck(null, areas)).toEqual(emptyReflectionDeck());
    expect(localStorage.getItem(reflectionDeckStorageKey(1))!.length).toBeLessThan(8000);
    const translated = guidedCaptureCatalog(getCatalog("en")).flatMap((group) => group.areas);
    expect(readReflectionDeck(1, translated)).toEqual(deck);
  });

  it("retains coverage and perspective rotation across returns", () => {
    let deck = nextReflectionCard(emptyReflectionDeck(), areas, () => 0);
    const first = deck.cards[0]!;
    for (let index = 1; index < 16; index++) {
      writeReflectionDeck(1, deck);
      deck = nextReflectionCard(readReflectionDeck(1, areas), areas, () => 0);
    }
    expect(new Set(deck.cards.map((card) => card.areaId)).size).toBe(16);
    for (let index = 0; index < 16; index++) deck = nextReflectionCard(deck, areas, () => 0);
    const repeated = deck.cards.slice(16).find((card) => card.areaId === first.areaId)!;
    expect(repeated.promptId).not.toBe(first.promptId);
  });

  it.each([
    "null", "{}", "{", '{"version":99}', "x".repeat(50_001),
  ])("recovers from malformed or unsupported storage (%s)", (raw) => {
    localStorage.setItem(reflectionDeckStorageKey(1), raw);
    expect(readReflectionDeck(1, areas)).toEqual(emptyReflectionDeck());
  });

  it("recovers from stale areas/questions, invalid positions and duplicate IDs", () => {
    const deck = nextReflectionCard(emptyReflectionDeck(), areas, () => 0);
    for (const patch of [
      { index: -1 }, { index: 999 }, { nextId: 0 },
      { seen: [] }, { seen: ["unknown"] }, { seen: ["family"] }, { seen: ["home", "home"] },
      { cards: [null] }, { cards: [{ ...deck.cards[0], areaId: "unknown" }] },
      { cards: [{ ...deck.cards[0], promptId: "removed" }] },
      { cards: [deck.cards[0], deck.cards[0]] },
    ]) {
      localStorage.setItem(reflectionDeckStorageKey(1), JSON.stringify({ ...deck, ...patch }));
      expect(readReflectionDeck(1, areas)).toEqual(emptyReflectionDeck());
    }
  });

  it("sanitizes removed perspective rotation and unknown fields", () => {
    const deck = nextReflectionCard(emptyReflectionDeck(), areas, () => 0);
    localStorage.setItem(reflectionDeckStorageKey(1), JSON.stringify({
      ...deck, draft: "never restore text",
      cards: [{ ...deck.cards[0], title: "never restore captured content" }],
      usedPrompts: { home: ["recall", "removed", "recall"], unknown: ["recall"] },
    }));
    const restored = readReflectionDeck(1, areas);
    expect(restored.usedPrompts.home).toEqual(["recall"]);
    expect(restored).not.toHaveProperty("draft");
    expect(restored.cards[0]).not.toHaveProperty("title");
    expect(restored.usedPrompts).not.toHaveProperty("unknown");
  });

  it("persists at most 48 cards even if drafts temporarily retain more in memory", () => {
    let deck = emptyReflectionDeck();
    const ids: number[] = [];
    for (let index = 0; index < 60; index++) {
      deck = nextReflectionCard(deck, areas, () => 0, ids);
      ids.push(deck.cards[deck.index]!.id);
    }
    writeReflectionDeck(1, deck);
    const restored = readReflectionDeck(1, areas);
    expect(restored.cards).toHaveLength(48);
    expect(restored.cards.at(-1)).toEqual(deck.cards.at(-1));
    expect(restored.seen).toEqual(deck.seen);
  });

  it("falls back to in-memory use when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Full"); });
    expect(readReflectionDeck(1, areas)).toEqual(emptyReflectionDeck());
    expect(() => writeReflectionDeck(1, emptyReflectionDeck())).not.toThrow();
  });
});
