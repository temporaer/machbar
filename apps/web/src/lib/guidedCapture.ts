import type { Strings } from "./strings";

// Groups organize the browser, not the deck order or task classification.
const lifeAreaGroups = [
  { id: "home", areas: [
    { id: "home", icon: "🏡" },
    { id: "household", icon: "🧺" },
    { id: "admin", icon: "📬" },
    { id: "digital", icon: "💻" },
  ] },
  { id: "people", areas: [
    { id: "family", icon: "🌱" },
    { id: "relationships", icon: "💛" },
    { id: "community", icon: "🤝" },
  ] },
  { id: "growth", areas: [
    { id: "health", icon: "🌿" },
    { id: "movement", icon: "🚲" },
    { id: "career", icon: "🧭" },
    { id: "learning", icon: "📚" },
  ] },
  { id: "resources", areas: [
    { id: "finances", icon: "☂️" },
    { id: "mobility", icon: "🚆" },
    { id: "travel", icon: "🧳" },
  ] },
  { id: "joy", areas: [
    { id: "hobbies", icon: "🎨" },
    { id: "celebrations", icon: "🎈" },
  ] },
] as const;

export function guidedCaptureCatalog(strings: Strings) {
  return lifeAreaGroups.map((group) => ({
    id: group.id,
    title: strings.guidedCaptureGroups[group.id],
    areas: group.areas.map((area) => ({
      ...area,
      tone: group.id,
      ...strings.guidedCaptureAreas[area.id],
    })),
  }));
}

type DeckArea = { id: string; tone: string; prompts: Record<string, string> };
export type ReflectionCard = { id: number; areaId: string; promptId: string };
export type ReflectionDeck = {
  version: 1;
  cards: ReflectionCard[];
  index: number;
  seen: string[];
  usedPrompts: Record<string, string[]>;
  nextId: number;
};

const HISTORY_LIMIT = 48;

export function emptyReflectionDeck(): ReflectionDeck {
  return { version: 1, cards: [], index: -1, seen: [], usedPrompts: {}, nextId: 1 };
}

/** Generate just one card at the frontier; existing forward history always wins. */
export function nextReflectionCard(
  deck: ReflectionDeck,
  areas: readonly DeckArea[],
  random = Math.random,
  protectedIds: readonly number[] = [],
): ReflectionDeck {
  if (deck.index < deck.cards.length - 1) return { ...deck, index: deck.index + 1 };
  return appendReflectionCard(deck, areas, random, protectedIds);
}

function appendReflectionCard(
  deck: ReflectionDeck,
  areas: readonly DeckArea[],
  random: () => number,
  protectedIds: readonly number[],
  chosenArea?: DeckArea,
): ReflectionDeck {
  const available = areas.filter((area) => !deck.seen.includes(area.id));
  const remaining = available.length ? available : areas;
  const previous = areas.find((area) => area.id === deck.cards.at(-1)?.areaId);
  const mixed = remaining.filter((area) => area.tone !== previous?.tone);
  const candidates = mixed.length ? mixed : remaining;
  const area = chosenArea ?? candidates[Math.floor(random() * candidates.length)];
  if (!area) return deck;
  const promptIds = Object.keys(area.prompts);
  const used = deck.usedPrompts[area.id] ?? [];
  const unused = promptIds.filter((id) => !used.includes(id));
  // At a pool boundary, don't immediately repeat the previous perspective.
  const alternatives = promptIds.filter((id) => id !== used.at(-1));
  const pool = unused.length ? unused : alternatives.length ? alternatives : promptIds;
  const promptId = pool[Math.floor(random() * pool.length)];
  if (!promptId) return deck;
  const cards = [...deck.cards, { id: deck.nextId, areaId: area.id, promptId }];
  // A draft/pending save must remain reachable even during a very long visit.
  while (cards.length > HISTORY_LIMIT) {
    const removable = cards.findIndex((card, index) =>
      index < cards.length - HISTORY_LIMIT && !protectedIds.includes(card.id));
    if (removable < 0) break;
    cards.splice(removable, 1);
  }
  return {
    version: 1,
    cards,
    index: cards.length - 1,
    seen: [...(available.length ? deck.seen : []), area.id],
    usedPrompts: { ...deck.usedPrompts, [area.id]: [...(unused.length ? used : []), promptId] },
    nextId: deck.nextId + 1,
  };
}

/** Picker jumps reuse a visited card, or append an unseen area at the frontier. */
export function visitReflectionArea(
  deck: ReflectionDeck,
  areas: readonly DeckArea[],
  areaId: string,
  random = Math.random,
  protectedIds: readonly number[] = [],
): ReflectionDeck {
  if (!areas.some((area) => area.id === areaId)) return deck;
  if (deck.cards[deck.index]?.areaId === areaId) return deck;
  const visited = deck.cards.findIndex((card) => card.areaId === areaId);
  if (visited >= 0) return { ...deck, index: visited };
  const target = areas.find((area) => area.id === areaId)!;
  // An area from an older, evicted cycle is not yet visited in this cycle.
  if (deck.seen.includes(areaId)) return deck;
  return appendReflectionCard(deck, areas, random, protectedIds, target);
}

export function reflectionDeckStorageKey(memberId: number) {
  return `machbar:reflection-deck:${memberId}`;
}

export function readReflectionDeck(memberId: number | null, areas: readonly DeckArea[]): ReflectionDeck {
  if (memberId === null) return emptyReflectionDeck();
  try {
    const raw = window.localStorage.getItem(reflectionDeckStorageKey(memberId));
    if (!raw || raw.length > 50_000) return emptyReflectionDeck();
    const value = JSON.parse(raw) as ReflectionDeck;
    if (value.version !== 1 || !Array.isArray(value.cards) || value.cards.length > HISTORY_LIMIT ||
      !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= value.cards.length ||
      !Number.isSafeInteger(value.nextId) || value.nextId < 1 ||
      !Array.isArray(value.seen) || value.seen.length > areas.length ||
      new Set(value.seen).size !== value.seen.length ||
      !value.seen.every((id) => areas.some((area) => area.id === id)) ||
      !value.usedPrompts || typeof value.usedPrompts !== "object") return emptyReflectionDeck();
    if (!value.cards.every((card) => Number.isSafeInteger(card.id) && card.id > 0 && card.id < value.nextId &&
      areas.some((area) => area.id === card.areaId && Object.hasOwn(area.prompts, card.promptId))) ||
      new Set(value.cards.map((card) => card.id)).size !== value.cards.length) return emptyReflectionDeck();
    const usedPrompts: Record<string, string[]> = {};
    for (const area of areas) {
      const used = value.usedPrompts[area.id];
      usedPrompts[area.id] = Array.isArray(used)
        ? [...new Set(used.filter((id) => typeof id === "string" && Object.hasOwn(area.prompts, id)))]
        : [];
    }
    // Reconstruct only known fields: never retain text or unknown stored data.
    return {
      version: 1,
      cards: value.cards.map(({ id, areaId, promptId }) => ({ id, areaId, promptId })),
      index: value.index, nextId: value.nextId, seen: value.seen, usedPrompts,
    };
  } catch {
    return emptyReflectionDeck();
  }
}

export function writeReflectionDeck(memberId: number | null, deck: ReflectionDeck) {
  if (memberId === null) return;
  try {
    const start = Math.max(0, deck.cards.length - HISTORY_LIMIT);
    const cards = deck.cards.slice(start);
    window.localStorage.setItem(reflectionDeckStorageKey(memberId),
      JSON.stringify({ ...deck, cards, index: Math.max(0, deck.index - start) }));
  } catch {
    // Browsing still works when storage is unavailable.
  }
}
