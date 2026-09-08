import { describe, expect, it } from "vitest";
import type { Member, PhysicalContext, Tag } from "@machbar/shared";
import type { ProjectWithActions } from "./api";
import {
  autoResolvedCaptureTokens,
  captureSyntaxSuggestions,
  mergeResolvedCaptureTokens,
  resolvedCaptureMetadata,
  stripResolvedTokens,
} from "./captureSyntax";
import { makeProject } from "../test/fixtures";

const referenceDate = new Date("2026-09-07T12:00:00.000Z");

const mira: Member = {
  id: 1,
  name: "Mira",
  color: "#146356",
  pictureUrl: null,
};

const tag: Tag = {
  id: 2,
  name: "Haushalt",
  color: "#64748b",
  kind: "area",
  groupingMode: "auto",
  sortPosition: null,
};

const context: PhysicalContext = {
  id: 3,
  source: "home_assistant",
  externalId: "home",
  name: "Zuhause",
  active: true,
  updatedAt: "2026-09-07T10:00:00.000Z",
};

const story: ProjectWithActions = {
  ...makeProject({
    id: 4,
    title: "Urlaub",
  }),
  availableActions: ["activate"],
  activationReadiness: {
    ready: true,
    hasDriver: true,
    hasViableProgressPath: true,
    hasHealthyFutureWaiting: false,
  },
};

describe("capture short syntax", () => {
  it("parses German and English date tokens through the natural date parser", () => {
    expect(
      autoResolvedCaptureTokens("Biotonne ~morgen !15.9", "de", referenceDate)
        .map((token) => token.kind === "scheduledDate" || token.kind === "dueDate" ? token.date : null),
    ).toEqual(["2026-09-08", "2026-09-15"]);
    expect(
      autoResolvedCaptureTokens("Trash ~tomorrow !Friday", "en", referenceDate)
        .map((token) => token.kind === "scheduledDate" || token.kind === "dueDate" ? token.date : null),
    ).toEqual(["2026-09-08", "2026-09-11"]);
  });

  it("offers entity-backed suggestions without resolving unknown tags", () => {
    const tagSuggestions = captureSyntaxSuggestions({
      input: "Milch #Haus",
      cursor: "Milch #Haus".length,
      locale: "de",
      members: [mira],
      tags: [tag],
      contexts: [context],
      stories: [story],
    });
    const unknownSuggestions = captureSyntaxSuggestions({
      input: "Milch #Whatever",
      cursor: "Milch #Whatever".length,
      locale: "de",
      members: [mira],
      tags: [tag],
      contexts: [context],
      stories: [story],
    });

    expect(tagSuggestions[0]?.token).toMatchObject({
      kind: "tag",
      tag: { id: tag.id, name: tag.name, kind: tag.kind },
    });
    expect(unknownSuggestions).toEqual([]);
  });

  it("shows all matching members and contexts for bare prefixes", () => {
    const sarah = { ...mira, id: 2, name: "Sarah" };
    const office = { ...context, id: 4, name: "Büro" };

    expect(
      captureSyntaxSuggestions({
        input: "@",
        cursor: 1,
        locale: "de",
        members: [sarah, mira],
        tags: [],
        contexts: [],
        stories: [],
      }).map((suggestion) => suggestion.label),
    ).toEqual(["Mira", "Sarah"]);
    expect(
      captureSyntaxSuggestions({
        input: "%",
        cursor: 1,
        locale: "de",
        members: [],
        tags: [],
        contexts: [office, context],
        stories: [],
      }).map((suggestion) => suggestion.label),
    ).toEqual(["Büro", "Zuhause"]);
  });

  it("builds structured metadata only from resolved tokens and strips them from the title", () => {
    const input = "Tickets buchen >Ur @Mira #Haus %Zu ~Freitag !15.9 :S";
    const auto = autoResolvedCaptureTokens(input, "de", referenceDate);
    const explicit = [
      captureSyntaxSuggestions({
        input,
        cursor: input.indexOf(">Ur") + 3,
        locale: "de",
        members: [mira],
        tags: [tag],
        contexts: [context],
        stories: [story],
      })[0]!.token,
      captureSyntaxSuggestions({
        input,
        cursor: input.indexOf("@Mira") + 5,
        locale: "de",
        members: [mira],
        tags: [tag],
        contexts: [context],
        stories: [story],
      })[0]!.token,
      captureSyntaxSuggestions({
        input,
        cursor: input.indexOf("#Haus") + 5,
        locale: "de",
        members: [mira],
        tags: [tag],
        contexts: [context],
        stories: [story],
      })[0]!.token,
      captureSyntaxSuggestions({
        input,
        cursor: input.indexOf("%Zu") + 3,
        locale: "de",
        members: [mira],
        tags: [tag],
        contexts: [context],
        stories: [story],
      })[0]!.token,
    ];
    const tokens = mergeResolvedCaptureTokens(explicit, auto);

    expect(stripResolvedTokens(input, tokens)).toBe("Tickets buchen");
    expect(resolvedCaptureMetadata(tokens)).toMatchObject({
      ownerMemberId: mira.id,
      projectId: story.id,
      dueDate: "2026-09-15",
      scheduledDate: "2026-09-11",
      size: "S",
      tagIds: [tag.id],
      contextIds: [context.id],
    });
  });

  it("keeps unresolved syntax literal", () => {
    const input = "Milch kaufen @Han #NewTag";
    const tokens = mergeResolvedCaptureTokens([], autoResolvedCaptureTokens(input, "de", referenceDate));

    expect(stripResolvedTokens(input, tokens)).toBe(input);
    expect(resolvedCaptureMetadata(tokens)).toMatchObject({
      tagIds: [],
      contextIds: [],
    });
  });
});
