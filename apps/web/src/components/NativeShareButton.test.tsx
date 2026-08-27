import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeShareButton } from "./NativeShareButton";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NativeShareButton", () => {
  it("uses the native share sheet with readable text and URL", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });

    render(<NativeShareButton title="Einkaufen" text={"Einkaufen\n\nMilch"} url="https://machbar.test/#/aufgaben/1" />);
    const button = screen.getByRole("button", { name: "Teilen" });
    expect(button).toHaveClass("icon-action-button");
    expect(button).toHaveAttribute("title", "Teilen");
    expect(button).not.toHaveTextContent("Teilen");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    await userEvent.click(button);

    await waitFor(() =>
      expect(share).toHaveBeenCalledWith({
        title: "Einkaufen",
        text: "Einkaufen\n\nMilch",
        url: "https://machbar.test/#/aufgaben/1",
      }),
    );
  });

  it("copies text and URL when native sharing is unavailable", async () => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<NativeShareButton title="Einkaufen" text="Einkaufen" url="https://machbar.test/#/aufgaben/1" />);
    await userEvent.click(screen.getByRole("button", { name: "Teilen" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "Einkaufen\n\nhttps://machbar.test/#/aufgaben/1",
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent("In die Zwischenablage kopiert");
  });

  it("can lift transient feedback into a sheet header status area", async () => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const onStatusChange = vi.fn();

    render(
      <NativeShareButton
        title="Einkaufen"
        text="Einkaufen"
        showStatus={false}
        onStatusChange={onStatusChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Teilen" }));

    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith("In die Zwischenablage kopiert"),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
