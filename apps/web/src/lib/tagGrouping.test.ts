import { describe, expect, it } from "vitest";
import { makeProject, makeTag } from "../test/fixtures";
import { groupItemsByTagKind } from "./tagGrouping";

describe("groupItemsByTagKind", () => {
  it("groups by the selected type without duplicating multi-tagged items", () => {
    const home = makeTag({ id: 1, name: "Zuhause", kind: "context" });
    const phone = makeTag({
      id: 2,
      name: "Telefon",
      kind: "context",
      groupingMode: "pinned",
    });
    const area = makeTag({ id: 3, name: "Garten", kind: "area" });
    const tagged = makeProject({ id: 10, effectiveTags: [home, phone, area] });
    const untagged = makeProject({ id: 11, effectiveTags: [area] });

    const groups = groupItemsByTagKind([tagged, untagged], "context");

    expect(groups.map((group) => group.tag?.name ?? null)).toEqual(["Telefon", null]);
    expect(groups.flatMap((group) => group.items).map((item) => item.id)).toEqual([10, 11]);
  });
});
