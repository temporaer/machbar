import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeMember } from "../test/fixtures";
import { TaskOwnerChoiceGroup } from "./TaskOwnerChoiceGroup";

const members = [
  makeMember({ id: 1, name: "Mira" }),
  makeMember({ id: 2, name: "Jonas" }),
];

describe("TaskOwnerChoiceGroup", () => {
  it("shows inherited, shared, and member choices in one accessible group", () => {
    render(
      <TaskOwnerChoiceGroup
        label="Zuständig"
        members={members}
        ownerMemberId={1}
        ownerInheritanceMode="explicit"
        inheritedOwnerId={2}
        inheritanceSource="parent"
        onChange={vi.fn()}
      />,
    );

    const group = screen.getByRole("group", { name: "Zuständig" });
    expect(
      within(group).getByRole("button", { name: "Von Aufgabe: Jonas" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(within(group).getByRole("button", { name: "Gemeinsam" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(group).getByRole("button", { name: "Mira" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("emits a complete persistence decision for every choice", async () => {
    const onChange = vi.fn();
    render(
      <TaskOwnerChoiceGroup
        label="Zuständig"
        members={members}
        ownerMemberId={null}
        ownerInheritanceMode="inherit"
        inheritedOwnerId={1}
        inheritanceSource="project"
        onChange={onChange}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Vom Projekt: Mira" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Gemeinsam" }));
    await userEvent.click(screen.getByRole("button", { name: "Jonas" }));

    expect(onChange).toHaveBeenNthCalledWith(1, {
      ownerMemberId: null,
      ownerInheritanceMode: "inherit",
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      ownerMemberId: null,
      ownerInheritanceMode: "none",
    });
    expect(onChange).toHaveBeenNthCalledWith(3, {
      ownerMemberId: 2,
      ownerInheritanceMode: "explicit",
    });
  });

  it("collapses standalone and legacy explicit-null tasks to shared", () => {
    const { rerender } = render(
      <TaskOwnerChoiceGroup
        label="Zuständig"
        members={members}
        ownerMemberId={null}
        ownerInheritanceMode="inherit"
        inheritedOwnerId={null}
        inheritanceSource={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /Vom|Von Aufgabe/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Gemeinsam" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    rerender(
      <TaskOwnerChoiceGroup
        label="Zuständig"
        members={members}
        ownerMemberId={null}
        ownerInheritanceMode="explicit"
        inheritedOwnerId={null}
        inheritanceSource={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Gemeinsam" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
