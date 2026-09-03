import { describe, expect, it } from "vitest";
import { makeTag } from "../test/fixtures";
import { taskCardDisplayTags } from "./TaskCardTags";

describe("taskCardDisplayTags", () => {
  it("excludes actor tags and sorts by kind, grouping priority, position, and name", () => {
    const tags = [
      makeTag({ id: 7, name: "Person", kind: "actor" }),
      makeTag({ id: 6, name: "Ohne Vorrang", kind: "area" }),
      makeTag({
        id: 5,
        name: "Zweiter Bereich",
        kind: "area",
        groupingMode: "pinned",
        sortPosition: 2,
      }),
      makeTag({
        id: 4,
        name: "Erster Bereich",
        kind: "area",
        groupingMode: "pinned",
        sortPosition: 1,
      }),
      makeTag({ id: 3, name: "Telefon", kind: "plain", groupingMode: "pinned" }),
      makeTag({ id: 2, name: "Draußen", kind: "plain" }),
    ];

    expect(taskCardDisplayTags(tags).map((tag) => tag.name)).toEqual([
      "Erster Bereich",
      "Zweiter Bereich",
      "Ohne Vorrang",
      "Telefon",
      "Draußen",
    ]);
  });
});
