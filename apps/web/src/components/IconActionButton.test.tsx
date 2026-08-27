import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IconActionButton } from "./IconActionButton";
import "../styles/index.css";

describe("IconActionButton", () => {
  it("provides the shared 44px, labelled icon control used by task and project actions", async () => {
    const onClick = vi.fn();
    render(<IconActionButton kind="owner" label="Verantwortlich" onClick={onClick} />);

    const button = screen.getByRole("button", { name: "Verantwortlich" });
    expect(button).toHaveClass("icon-action-button");
    expect(button).toHaveAttribute("title", "Verantwortlich");
    expect(getComputedStyle(button).width).toBe("44px");
    expect(getComputedStyle(button).height).toBe("44px");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(button.querySelector("svg")).toHaveAttribute("focusable", "false");

    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
