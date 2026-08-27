import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BottomSheet } from "./BottomSheet";

describe("BottomSheet", () => {
  it("renders header actions beside a thumb-sized close action and compact status", async () => {
    const onClose = vi.fn();
    render(
      <BottomSheet
        title="Details"
        labelledBy="details-title"
        onClose={onClose}
        headerActions={<button type="button">Teilen</button>}
        headerStatus={<span role="status">Geteilt</span>}
      >
        Inhalt
      </BottomSheet>,
    );

    const header = screen
      .getByRole("heading", { name: "Details" })
      .closest<HTMLElement>(".sheet-header");
    expect(header).not.toBeNull();
    expect(within(header!).getByRole("button", { name: "Teilen" })).toBeInTheDocument();
    const close = within(header!).getByRole("button", { name: "Schließen" });
    expect(close).toHaveClass("icon-action-button");
    expect(screen.getByRole("status")).toHaveTextContent("Geteilt");

    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
