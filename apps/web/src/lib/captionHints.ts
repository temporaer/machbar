import type { Member, PhysicalContext, Tag } from "@machbar/shared";
import type { Locale } from "../i18n/catalog";
import { parseNaturalDate } from "./naturalDate";

export interface CaptionHintSpan {
  start: number;
  end: number;
}

interface CaptionHintBase {
  key: string;
  source: string;
  sourceSpan: CaptionHintSpan;
  removalSpan: CaptionHintSpan;
  rank: number;
}

export type TemporalHintSemantic =
  | "scheduledDate"
  | "dueDate"
  | "followUp"
  | "ambiguous";

export interface TemporalCaptionHint extends CaptionHintBase {
  kind: "temporal";
  date: string;
  semantic: TemporalHintSemantic;
}

export interface MemberCaptionHint extends CaptionHintBase {
  kind: "member";
  member: Member;
}

export interface TagCaptionHint extends CaptionHintBase {
  kind: "tag";
  tag: Tag;
}

export interface ContextCaptionHint extends CaptionHintBase {
  kind: "context";
  context: PhysicalContext;
}

export interface WaitingCaptionHint extends CaptionHintBase {
  kind: "waiting";
  waitingFor: string;
  member: Member | null;
}

export type CaptionHint =
  | TemporalCaptionHint
  | MemberCaptionHint
  | TagCaptionHint
  | ContextCaptionHint
  | WaitingCaptionHint;

export interface CaptionHintContext {
  locale: Locale;
  referenceDate: Date;
  members?: readonly Member[];
  tags?: readonly Tag[];
  contexts?: readonly PhysicalContext[];
}

const TEMPORAL_FRAGMENT = [
  "heute\\s+abend",
  "morgen\\s+früh",
  "uebermorgen",
  "übermorgen",
  "heute",
  "morgen",
  "today",
  "tomorrow",
  "tonight",
  "in\\s+\\d+\\s+(?:tagen?|wochen?|days?|weeks?)",
  "nächste\\s+woche",
  "naechste\\s+woche",
  "next\\s+week",
  "(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mo|di|mi|do|fr|sa|so|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\\.?(?:\\s+(?:\\d{1,2}(?::\\d{2})?|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)))?",
  "\\d{1,2}\\.\\d{1,2}(?:\\.\\d{2,4})?(?:\\s+\\d{1,2}(?::\\d{2})?)?",
  "\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?(?:\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)?",
].join("|");

const DEADLINE_MARKER = "(?:bis|spätestens|spaetestens|fällig(?:\\s+am)?|faellig(?:\\s+am)?|due(?:\\s+by)?|by|no\\s+later\\s+than)";
const FOLLOW_UP_MARKER = "(?:erinnern|nachhaken|nochmal(?:\\s+nachhaken)?|follow[\\s-]?up|remind)";
const LEFT_BOUNDARY = "(?<![\\p{L}\\p{N}])";
const RIGHT_BOUNDARY = "(?![\\p{L}\\p{N}])";
const GERMAN_WEEKDAYS = new Set([
  "mo", "di", "mi", "do", "fr", "sa", "so",
  "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag", "sonntag",
]);
const ENGLISH_WEEKDAYS = new Set([
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

interface TemporalPattern {
  regex: RegExp;
  semantic: TemporalHintSemantic;
  rank: number;
}

const temporalPatterns: readonly TemporalPattern[] = [
  {
    regex: new RegExp(
      `${LEFT_BOUNDARY}(?<source>${DEADLINE_MARKER}\\s+(?<date>${TEMPORAL_FRAGMENT}))${RIGHT_BOUNDARY}`,
      "giu",
    ),
    semantic: "dueDate",
    rank: 0,
  },
  {
    regex: new RegExp(
      `${LEFT_BOUNDARY}(?<source>(?<date>${TEMPORAL_FRAGMENT})\\s+${FOLLOW_UP_MARKER})${RIGHT_BOUNDARY}`,
      "giu",
    ),
    semantic: "followUp",
    rank: 0,
  },
  {
    regex: new RegExp(
      `${LEFT_BOUNDARY}(?<source>${FOLLOW_UP_MARKER}\\s+(?:am\\s+|on\\s+)?(?<date>${TEMPORAL_FRAGMENT}))${RIGHT_BOUNDARY}`,
      "giu",
    ),
    semantic: "followUp",
    rank: 0,
  },
  {
    regex: new RegExp(
      `${LEFT_BOUNDARY}(?<source>(?<date>${TEMPORAL_FRAGMENT}))${RIGHT_BOUNDARY}`,
      "giu",
    ),
    semantic: "scheduledDate",
    rank: 2,
  },
];

function parseTemporalFragment(
  fragment: string,
  referenceDate: Date,
  locale: Locale,
): string | null {
  const parsed = parseNaturalDate(fragment, referenceDate, locale);
  if (parsed) return parsed;
  const withoutTime = fragment.replace(
    /\s+(?:früh|abend|\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})$/i,
    "",
  );
  return withoutTime === fragment
    ? null
    : parseNaturalDate(withoutTime, referenceDate, locale);
}

function overlaps(a: CaptionHintSpan, b: CaptionHintSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

function temporalHints(
  text: string,
  referenceDate: Date,
  locale: Locale,
): TemporalCaptionHint[] {
  const candidates: TemporalCaptionHint[] = [];
  for (const pattern of temporalPatterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const source = match.groups?.source;
      const fragment = match.groups?.date;
      if (!source || !fragment || match.index === undefined) continue;
      const weekdayToken = fold(fragment.split(/\s+/)[0]!.replace(/\.$/, ""), locale);
      if (
        (locale === "de" && ENGLISH_WEEKDAYS.has(weekdayToken)) ||
        (locale === "en" && GERMAN_WEEKDAYS.has(weekdayToken))
      ) {
        continue;
      }
      if (
        pattern.semantic === "scheduledDate" &&
        (weekdayToken === "do" || weekdayToken === "so") &&
        fragment.trim().split(/\s+/).length === 1
      ) {
        continue;
      }
      const date = parseTemporalFragment(fragment, referenceDate, locale);
      if (!date) continue;
      const start = match.index;
      const span = { start, end: start + source.length };
      candidates.push({
        kind: "temporal",
        key: `temporal:${start}:${span.end}:${date}:${pattern.semantic}`,
        source,
        sourceSpan: span,
        removalSpan: span,
        date,
        semantic: pattern.semantic,
        rank: pattern.rank,
      });
    }
  }

  const selected: TemporalCaptionHint[] = [];
  for (const candidate of candidates.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.sourceSpan.end - b.sourceSpan.start -
        (a.sourceSpan.end - a.sourceSpan.start) ||
      a.sourceSpan.start - b.sourceSpan.start,
  )) {
    if (!selected.some((hint) => overlaps(hint.sourceSpan, candidate.sourceSpan))) {
      selected.push(candidate);
    }
  }
  return selected.sort((a, b) => a.sourceSpan.start - b.sourceSpan.start);
}

interface IndexedWord {
  folded: string;
  start: number;
  end: number;
  raw: string;
}

function fold(value: string, locale: Locale): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase(locale);
}

function words(value: string, locale: Locale): IndexedWord[] {
  return [...value.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    folded: fold(match[0], locale),
    start: match.index!,
    end: match.index! + match[0].length,
    raw: match[0],
  }));
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  let left = 0;
  let right = 0;
  let differences = 0;
  while (left < a.length && right < b.length) {
    if (a[left] === b[right]) {
      left += 1;
      right += 1;
      continue;
    }
    differences += 1;
    if (differences > 1) return false;
    if (a.length > b.length) left += 1;
    else if (b.length > a.length) right += 1;
    else {
      left += 1;
      right += 1;
    }
  }
  return differences + Number(left < a.length || right < b.length) <= 1;
}

interface EntityMatch {
  span: CaptionHintSpan;
  source: string;
  rank: number;
}

function entityMatch(
  text: string,
  name: string,
  locale: Locale,
  explicitPrefix: string,
  includeOwnerPreposition = false,
): EntityMatch | null {
  const textWords = words(text, locale);
  const nameWords = words(name, locale);
  if (nameWords.length === 0) return null;
  const foldedName = nameWords.map((word) => word.folded).join(" ");

  for (let index = 0; index <= textWords.length - nameWords.length; index += 1) {
    const slice = textWords.slice(index, index + nameWords.length);
    const candidate = slice.map((word) => word.folded).join(" ");
    const first = slice[0]!;
    const last = slice.at(-1)!;
    const hasPrefix = text.slice(Math.max(0, first.start - 1), first.start) === explicitPrefix;
    if (candidate === foldedName) {
      let start = hasPrefix ? first.start - 1 : first.start;
      if (includeOwnerPreposition && !hasPrefix) {
        const before = text.slice(0, start);
        const preposition = /(?:^|\s)(?:für|fuer|for)\s+$/iu.exec(before);
        if (preposition) start = preposition.index + (preposition[0].startsWith(" ") ? 1 : 0);
      }
      return {
        span: { start, end: last.end },
        source: text.slice(start, last.end),
        rank: hasPrefix ? 0 : 1,
      };
    }
  }

  if (nameWords.length !== 1 || foldedName.length < 4) return null;
  for (const word of textWords) {
    if (word.folded.length < 3) continue;
    if (
      word.folded.startsWith(foldedName) ||
      foldedName.startsWith(word.folded)
    ) {
      return {
        span: { start: word.start, end: word.end },
        source: word.raw,
        rank: 3,
      };
    }
    if (
      foldedName.length >= 5 &&
      word.folded.length >= 5 &&
      editDistanceAtMostOne(word.folded, foldedName)
    ) {
      return {
        span: { start: word.start, end: word.end },
        source: word.raw,
        rank: 4,
      };
    }
  }
  return null;
}

function memberHints(
  text: string,
  members: readonly Member[],
  locale: Locale,
): MemberCaptionHint[] {
  return members.flatMap((member) => {
    const match = entityMatch(text, member.name, locale, "@", true);
    if (!match) return [];
    return [{
      kind: "member" as const,
      key: `member:${member.id}:${match.span.start}:${match.span.end}`,
      source: match.source,
      sourceSpan: match.span,
      removalSpan: match.span,
      member,
      rank: match.rank,
    }];
  });
}

function tagHints(
  text: string,
  tags: readonly Tag[],
  locale: Locale,
): TagCaptionHint[] {
  return tags.flatMap((tag) => {
    const match = entityMatch(text, tag.name, locale, "#");
    if (!match) return [];
    return [{
      kind: "tag" as const,
      key: `tag:${tag.id}:${match.span.start}:${match.span.end}`,
      source: match.source,
      sourceSpan: match.span,
      removalSpan: match.span,
      tag,
      rank: match.rank,
    }];
  });
}

function contextHints(
  text: string,
  contexts: readonly PhysicalContext[],
  locale: Locale,
): ContextCaptionHint[] {
  return contexts.flatMap((context) => {
    if (!context.active) return [];
    const match = entityMatch(text, context.name, locale, "%");
    if (!match) return [];
    return [{
      kind: "context" as const,
      key: `context:${context.id}:${match.span.start}:${match.span.end}`,
      source: match.source,
      sourceSpan: match.span,
      removalSpan: match.span,
      context,
      rank: match.rank,
    }];
  });
}

const WAITING_PATTERNS = [
  /(?<source>auf\s+(?<person>[\p{L}\p{N}][\p{L}\p{N} .'-]{0,40}?)\s+warten)/giu,
  /(?<source>rückmeldung\s+von\s+(?<person>[\p{L}\p{N}][\p{L}\p{N} .'-]{1,40}))/giu,
  /(?<source>(?<person>[\p{L}\p{N}][\p{L}\p{N} .'-]{0,40}?)\s+fragen\s+und\s+warten)/giu,
  /(?<source>wait(?:ing)?\s+for\s+(?<person>[\p{L}\p{N}][\p{L}\p{N} .'-]{1,40}))/giu,
  /(?<source>response\s+from\s+(?<person>[\p{L}\p{N}][\p{L}\p{N} .'-]{1,40}))/giu,
] as const;

function waitingHints(
  text: string,
  members: readonly Member[],
  locale: Locale,
): WaitingCaptionHint[] {
  const hints: WaitingCaptionHint[] = [];
  for (const pattern of WAITING_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined || !match.groups?.source || !match.groups.person) continue;
      const source = match.groups.source.trim();
      const rawPerson = match.groups.person.trim().replace(/[.,;:!?]+$/u, "");
      const member =
        members.find((candidate) => fold(candidate.name, locale) === fold(rawPerson, locale)) ??
        members.find((candidate) => {
          const entity = entityMatch(rawPerson, candidate.name, locale, "@");
          return entity?.rank === 1;
        }) ??
        null;
      const start = match.index + match[0].indexOf(match.groups.source);
      const span = { start, end: start + source.length };
      hints.push({
        kind: "waiting",
        key: `waiting:${start}:${span.end}:${fold(rawPerson, locale)}`,
        source,
        sourceSpan: span,
        removalSpan: span,
        waitingFor: member?.name ?? rawPerson,
        member,
        rank: member ? 0 : 1,
      });
    }
  }
  return hints;
}

export function extractCaptionHints(
  text: string,
  context: CaptionHintContext,
): CaptionHint[] {
  const { locale, referenceDate } = context;
  return [
    ...temporalHints(text, referenceDate, locale),
    ...memberHints(text, context.members ?? [], locale),
    ...tagHints(text, context.tags ?? [], locale),
    ...contextHints(text, context.contexts ?? [], locale),
    ...waitingHints(text, context.members ?? [], locale),
  ].sort(
    (a, b) =>
      a.rank - b.rank ||
      a.sourceSpan.start - b.sourceSpan.start ||
      a.key.localeCompare(b.key),
  );
}

export function strongestCaptionHints<T extends CaptionHint>(
  hints: readonly T[],
  limit = 3,
): T[] {
  return [...hints]
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.sourceSpan.start - b.sourceSpan.start ||
        a.key.localeCompare(b.key),
    )
    .slice(0, limit);
}

export function removeCaptionHintSpans(
  text: string,
  spans: readonly CaptionHintSpan[],
): string {
  let result = text;
  const unique = new Map(spans.map((span) => [`${span.start}:${span.end}`, span]));
  for (const span of [...unique.values()].sort((a, b) => b.start - a.start)) {
    result = `${result.slice(0, span.start)}${result.slice(span.end)}`;
  }
  const cleaned = result
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || text;
}
