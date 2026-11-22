import { describe, expect, it } from "vitest";
import { markdownChecklistProgress } from "./markdownChecklist";

describe("markdownChecklistProgress", () => {
  it("counts task items but excludes ordinary items in a mixed list", () => {
    expect(markdownChecklistProgress("- [x] Milk\n- [ ] Bread\n- Go to the shop")).toEqual({
      completed: 1,
      total: 2,
    });
  });

  it("counts nested task items", () => {
    expect(markdownChecklistProgress("- [x] Parent\n  - [ ] Child\n    - [X] Grandchild")).toEqual({
      completed: 2,
      total: 3,
    });
  });

  it("ignores checkbox-like text in fenced code", () => {
    expect(markdownChecklistProgress("```md\n- [x] Example\n```\n- [ ] Real item")).toEqual({
      completed: 0,
      total: 1,
    });
    expect(markdownChecklistProgress("```md\n- [x] Example\n```")).toBeNull();
  });

  it("accepts a task marker on the following line of a list item", () => {
    expect(markdownChecklistProgress("-\n  [ ] Multiline item")).toEqual({
      completed: 0,
      total: 1,
    });
  });

  it("returns null when there is no task list", () => {
    expect(markdownChecklistProgress("Plain note without brackets")).toBeNull();
    expect(markdownChecklistProgress("A bracketed [x] phrase, but no list")).toBeNull();
  });
});
