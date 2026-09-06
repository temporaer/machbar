import { describe, expect, it } from "vitest";
import { makeProject, makeTag } from "../test/fixtures";
import { groupItemsByTagKind } from "./tagGrouping";

describe("groupItemsByTagKind", () => {
  it("groups by the selected type without duplicating multi-tagged items", () => {
    const home = makeTag({ id: 1, name: "Zuhause", kind: "area" });
    const phone = makeTag({
      id: 2,
      name: "Telefon",
      kind: "area",
      groupingMode: "pinned",
    });
    const tagged = makeProject({ id: 10, effectiveTags: [home, phone] });
    const untagged = makeProject({ id: 11, effectiveTags: [] });

    const groups = groupItemsByTagKind([tagged, untagged], "area");

    expect(groups.map((group) => group.tag?.name ?? null)).toEqual(["Telefon", null]);
    expect(groups.flatMap((group) => group.items).map((item) => item.id)).toEqual([10, 11]);
  });
});
