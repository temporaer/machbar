import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemberChoiceGroup } from "./MemberChoiceGroup";
import { makeMember } from "../test/fixtures";

/**
 * The shared picker behind every focused assignment popup. These tests pin the
 * two properties the surfaces above depend on: it never renders a `<select>`
 * (mobile tap targets only), and selection state is exposed through
 * `aria-pressed` inside an accessibly labelled group.
 */
describe("MemberChoiceGroup", () => {
  // A household tops out at five people — the whole set has to stay tappable.
  const household = [
    makeMember({ id: 1, name: "Mira" }),
    makeMember({ id: 2, name: "Jonas" }),
    makeMember({ id: 3, name: "Lea" }),
    makeMember({ id: 4, name: "Timo" }),
    makeMember({ id: 5, name: "Ada" }),
  ];

  it("renders one tap button per member plus the unassigned choice — never a select", () => {
    render(
      <MemberChoiceGroup
        label="Zuständig"
        idPrefix="test-owner"
        members={household}
        value={null}
        onChange={vi.fn()}
        unassignedLabel="Gemeinsam / offen"
      />,
    );

    const group = screen.getByRole("group", { name: "Zuständig" });
    expect(within(group).queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Gemeinsam / offen", "Mira", "Jonas", "Lea", "Timo", "Ada"]);
  });

  it("marks exactly the current choice with aria-pressed", () => {
    render(
      <MemberChoiceGroup
        label="Zuständig"
        idPrefix="test-owner"
        members={household}
        value={3}
        onChange={vi.fn()}
        unassignedLabel="Gemeinsam / offen"
      />,
    );

    const group = screen.getByRole("group", { name: "Zuständig" });
    const pressed = within(group)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent);
    expect(pressed).toEqual(["Lea"]);
  });

  it("presses the unassigned choice while nobody is selected", () => {
    render(
      <MemberChoiceGroup
        label="Verantwortlich"
        idPrefix="test-driver"
        members={household}
        value={null}
        onChange={vi.fn()}
        unassignedLabel="Niemand zugewiesen"
      />,
    );

    expect(screen.getByRole("button", { name: "Niemand zugewiesen" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("reports the tapped member id, and null for the unassigned choice", async () => {
    const onChange = vi.fn();
    render(
      <MemberChoiceGroup
        label="Zuständig"
        idPrefix="test-owner"
        members={household}
        value={2}
        onChange={onChange}
        unassignedLabel="Gemeinsam / offen"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Timo" }));
    expect(onChange).toHaveBeenLastCalledWith(4);

    await userEvent.click(screen.getByRole("button", { name: "Gemeinsam / offen" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("omits the unassigned choice when clearing is not a legal outcome", () => {
    render(
      <MemberChoiceGroup
        label="Verantwortlich"
        idPrefix="test-driver"
        members={household}
        value={null}
        onChange={vi.fn()}
        unassignedLabel={null}
      />,
    );

    const group = screen.getByRole("group", { name: "Verantwortlich" });
    expect(within(group).getAllByRole("button")).toHaveLength(household.length);
    expect(
      within(group).queryByRole("button", { name: "Niemand zugewiesen" }),
    ).not.toBeInTheDocument();
  });

  it("disables every choice while a save is in flight", () => {
    render(
      <MemberChoiceGroup
        label="Zuständig"
        idPrefix="test-owner"
        members={household}
        value={1}
        onChange={vi.fn()}
        unassignedLabel="Gemeinsam / offen"
        disabled
      />,
    );

    const group = screen.getByRole("group", { name: "Zuständig" });
    for (const button of within(group).getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("focuses the current choice on open so keyboard users land on it", () => {
    render(
      <MemberChoiceGroup
        label="Zuständig"
        idPrefix="test-owner"
        members={household}
        value={2}
        onChange={vi.fn()}
        unassignedLabel="Gemeinsam / offen"
        autoFocus
      />,
    );

    expect(screen.getByRole("button", { name: "Jonas" })).toHaveFocus();
  });

  it("falls back to the first member when there is no unassigned choice to focus", () => {
    render(
      <MemberChoiceGroup
        label="Verantwortlich"
        idPrefix="test-driver"
        members={household}
        value={null}
        onChange={vi.fn()}
        unassignedLabel={null}
        autoFocus
      />,
    );

    expect(screen.getByRole("button", { name: "Mira" })).toHaveFocus();
  });
});
