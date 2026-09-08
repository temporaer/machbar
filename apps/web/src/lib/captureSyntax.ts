import type { Member, PhysicalContext, Tag, TaskSize } from "@machbar/shared";
import type { ProjectWithActions } from "./api";
import type { Locale } from "../i18n/catalog";
import { parseNaturalDate } from "./naturalDate";

export type CaptureTokenKind =
  | "scheduledDate"
  | "dueDate"
  | "member"
  | "tag"
  | "context"
  | "story"
  | "size";

export interface CaptureTokenSpan {
  start: number;
  end: number;
  raw: string;
  query: string;
  kind: CaptureTokenKind;
}

export type ResolvedCaptureToken =
  | (CaptureTokenSpan & { kind: "scheduledDate" | "dueDate"; date: string })
  | (CaptureTokenSpan & { kind: "member"; member: Member })
  | (CaptureTokenSpan & { kind: "tag"; tag: Tag })
  | (CaptureTokenSpan & { kind: "context"; context: PhysicalContext })
  | (CaptureTokenSpan & { kind: "story"; story: ProjectWithActions })
  | (CaptureTokenSpan & { kind: "size"; size: TaskSize });

export interface CaptureSyntaxSuggestion {
  key: string;
  label: string;
  description?: string;
  token: ResolvedCaptureToken;
}

export function modifierCaptureToken(
  token:
    | { kind: "member"; member: Member }
    | { kind: "context"; context: PhysicalContext }
    | { kind: "story"; story: ProjectWithActions }
    | { kind: "scheduledDate"; date: string },
): ResolvedCaptureToken {
  return {
    ...token,
    start: 0,
    end: 0,
    raw: "",
    query: "",
  };
}

const tokenPattern = /(?:^|\s)([~!@#%>:][^\s]*)/g;
const sizes = new Set<TaskSize>(["S", "M", "L", "XL"]);

function tokenKind(raw: string): CaptureTokenKind | null {
  const prefix = raw[0];
  if (prefix === "~") return "scheduledDate";
  if (prefix === "!") return "dueDate";
  if (prefix === "@") return "member";
  if (prefix === "#") return "tag";
  if (prefix === "%") return "context";
  if (prefix === ">") return "story";
  if (prefix === ":") return "size";
  return null;
}

export function scanCaptureTokens(input: string): CaptureTokenSpan[] {
  const tokens: CaptureTokenSpan[] = [];
  for (const match of input.matchAll(tokenPattern)) {
    const raw = match[1]!;
    const kind = tokenKind(raw);
    if (!kind) continue;
    const start = (match.index ?? 0) + match[0].length - raw.length;
    tokens.push({
      start,
      end: start + raw.length,
      raw,
      query: raw.slice(1),
      kind,
    });
  }
  return tokens;
}

export function activeCaptureToken(
  input: string,
  cursor: number,
): CaptureTokenSpan | null {
  return (
    scanCaptureTokens(input).find(
      (token) => token.start < cursor && cursor <= token.end,
    ) ?? null
  );
}

function includes(haystack: string, needle: string, locale: Locale): boolean {
  return haystack.toLocaleLowerCase(locale).includes(needle.toLocaleLowerCase(locale));
}

export function autoResolvedCaptureTokens(
  input: string,
  locale: Locale,
  referenceDate = new Date(),
): ResolvedCaptureToken[] {
  return scanCaptureTokens(input).flatMap((token) => {
    if ((token.kind === "scheduledDate" || token.kind === "dueDate") && token.query) {
      const date = parseNaturalDate(token.query, referenceDate, locale);
      return date ? [{ ...token, date } as ResolvedCaptureToken] : [];
    }
    if (token.kind === "size") {
      const size = token.query.toUpperCase() as TaskSize;
      return sizes.has(size) ? [{ ...token, query: size, size } as ResolvedCaptureToken] : [];
    }
    return [];
  });
}

export function captureSyntaxSuggestions({
  input,
  cursor,
  locale,
  members,
  tags,
  contexts,
  stories,
}: {
  input: string;
  cursor: number;
  locale: Locale;
  members: readonly Member[];
  tags: readonly Tag[];
  contexts: readonly PhysicalContext[];
  stories: readonly ProjectWithActions[];
}): CaptureSyntaxSuggestion[] {
  const token = activeCaptureToken(input, cursor);
  if (!token || token.kind === "scheduledDate" || token.kind === "dueDate" || token.kind === "size") {
    return [];
  }
  const query = token.query;
  switch (token.kind) {
    case "member":
      return members
        .filter((member) => includes(member.name, query, locale))
        .sort((a, b) => a.name.localeCompare(b.name, locale))
        .map((member) => ({
          key: `member-${member.id}`,
          label: member.name,
          token: {
            ...token,
            kind: "member",
            member,
            raw: input.slice(token.start, token.end),
          },
        }));
    case "tag":
      return tags
        .filter((tag) => includes(tag.name, query, locale))
        .sort((a, b) => a.name.localeCompare(b.name, locale))
        .map((tag) => ({
          key: `tag-${tag.id}`,
          label: tag.name,
          description: tag.kind,
          token: {
            ...token,
            kind: "tag",
            tag,
            raw: input.slice(token.start, token.end),
          },
        }));
    case "context":
      return contexts
        .filter((context) => context.active && includes(context.name, query, locale))
        .sort((a, b) => a.name.localeCompare(b.name, locale))
        .map((context) => ({
          key: `context-${context.id}`,
          label: context.name,
          token: {
            ...token,
            kind: "context",
            context,
            raw: input.slice(token.start, token.end),
          },
        }));
    case "story":
      return stories
        .filter((story) => includes(story.title, query, locale))
        .sort((a, b) => a.title.localeCompare(b.title, locale))
        .map((story) => ({
          key: `story-${story.id}`,
          label: story.title,
          description: story.status,
          token: {
            ...token,
            kind: "story",
            story,
            raw: input.slice(token.start, token.end),
          },
        }));
    default:
      return [];
  }
}

export function mergeResolvedCaptureTokens(
  explicit: readonly ResolvedCaptureToken[],
  automatic: readonly ResolvedCaptureToken[],
): ResolvedCaptureToken[] {
  const result = new Map<string, ResolvedCaptureToken>();
  for (const token of [...automatic, ...explicit]) {
    const identity =
      "member" in token
        ? token.member.id
        : "context" in token
          ? token.context.id
          : "story" in token
            ? token.story.id
            : "date" in token
              ? token.date
              : "size" in token
                ? token.size
                : token.raw;
    result.set(`${token.kind}:${token.start}:${token.end}:${identity}`, token);
  }
  return [...result.values()].sort((a, b) => a.start - b.start);
}

export function stripResolvedTokens(
  input: string,
  tokens: readonly ResolvedCaptureToken[],
): string {
  let output = input;
  for (const token of [...tokens].sort((a, b) => b.start - a.start)) {
    if (output.slice(token.start, token.end) === token.raw) {
      output = `${output.slice(0, token.start)}${output.slice(token.end)}`;
    }
  }
  return output.replace(/\s+/g, " ").trim();
}

export function resolvedCaptureMetadata(tokens: readonly ResolvedCaptureToken[]) {
  const tagIds = new Set<number>();
  const contextIds = new Set<number>();
  let ownerMemberId: number | null | undefined;
  let projectId: number | null | undefined;
  let dueDate: string | null | undefined;
  let scheduledDate: string | null | undefined;
  let size: TaskSize | null | undefined;
  for (const token of tokens) {
    if (token.kind === "tag") tagIds.add(token.tag.id);
    if (token.kind === "context") contextIds.add(token.context.id);
    if (token.kind === "member") ownerMemberId = token.member.id;
    if (token.kind === "story") projectId = token.story.id;
    if (token.kind === "dueDate") dueDate = token.date;
    if (token.kind === "scheduledDate") scheduledDate = token.date;
    if (token.kind === "size") size = token.size;
  }
  return {
    ownerMemberId,
    projectId,
    dueDate,
    scheduledDate,
    size,
    tagIds: [...tagIds],
    contextIds: [...contextIds],
  };
}
