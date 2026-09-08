import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makePhysicalContext } from "../test/fixtures";
import { PhysicalContextPicker } from "./PhysicalContextPicker";

const kitchen = makePhysicalContext({ id: 1, name: "Küche" });
const garden = makePhysicalContext({ id: 2, name: "Garten" });

describe("PhysicalContextPicker", () => {
  it("shows active context choices immediately for standalone use (no mode)", () => {
    const onChange = vi.fn();
    render(
      <PhysicalContextPicker
        contexts={[kitchen, garden]}
        selected={[kitchen]}
        onChange={onChange}
      />,
    );

    const group = screen.getByRole("group", { name: "Physische Kontexte" });
    expect(within(group).getByRole("button", { name: "Küche" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(group).getByRole("button", { name: "Garten" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Standalone contexts have no inheritance concept, so no "none" chip.
    expect(screen.queryByRole("button", { name: "Kein Kontext" })).toBeNull();
  });

  it("calls onChange with explicit mode when selecting a context standalone", async () => {
    const onChange = vi.fn();
    render(
      <PhysicalContextPicker
        contexts={[kitchen, garden]}
        selected={[]}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Garten" }));
    expect(onChange).toHaveBeenCalledWith(undefined, [2]);
  });

  it("shows active context choices immediately when there is no meaningful inherited value", () => {
    render(
      <PhysicalContextPicker
        contexts={[kitchen, garden]}
        selected={[]}
        inherited={[]}
        mode="inherit"
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Geerbt/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Vom Projekt übernehmen" })).toBeNull();
    expect(screen.getByRole("button", { name: "Kein Kontext" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("displays a real inherited value clearly and allows direct override", async () => {
    const onChange = vi.fn();
    render(
      <PhysicalContextPicker
        contexts={[kitchen, garden]}
        selected={[]}
        inherited={[kitchen]}
        mode="inherit"
        onChange={onChange}
      />,
    );

    expect(screen.getByText("Geerbt: Küche")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Küche" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Overriding by picking a different context switches to explicit selection.
    await userEvent.click(screen.getByRole("button", { name: "Garten" }));
    expect(onChange).toHaveBeenCalledWith("explicit", [1, 2]);
  });

  it("offers a 'Vom Projekt übernehmen' action to restore inheritance once overridden", async () => {
    const onChange = vi.fn();
    render(
      <PhysicalContextPicker
        contexts={[kitchen, garden]}
        selected={[garden]}
        inherited={[kitchen]}
        mode="explicit"
        onChange={onChange}
      />,
    );

    const restoreButton = screen.getByRole("button", {
      name: "Vom Projekt übernehmen",
    });
    await userEvent.click(restoreButton);
    expect(onChange).toHaveBeenCalledWith("inherit", []);
  });

  it("exposes deliberate none as a localized 'Kein Kontext' choice", async () => {
    const onChange = vi.fn();
    render(
      <PhysicalContextPicker
        contexts={[kitchen, garden]}
        selected={[]}
        inherited={[kitchen]}
        mode="none"
        onChange={onChange}
      />,
    );

    const noneButton = screen.getByRole("button", { name: "Kein Kontext" });
    expect(noneButton).toHaveAttribute("aria-pressed", "true");
    // Still overridden relative to the project, so restoring inheritance is offered.
    expect(
      screen.getByRole("button", { name: "Vom Projekt übernehmen" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Küche" }));
    expect(onChange).toHaveBeenCalledWith("explicit", [1]);
  });

  it("shows the empty-catalogue hint when there are no places to pick", () => {
    render(
      <PhysicalContextPicker contexts={[]} selected={[]} onChange={vi.fn()} />,
    );

    expect(
      screen.getByText("Noch keine Orte aus Home Assistant synchronisiert."),
    ).toBeInTheDocument();
  });
});
