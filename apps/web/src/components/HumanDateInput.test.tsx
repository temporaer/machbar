import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HumanDateInput } from "./HumanDateInput";

describe("HumanDateInput", () => {
  it("commits natural language and compact relative input as ISO dates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 27, 12));
    const onChange = vi.fn();
    render(<HumanDateInput id="date" value="" onChange={onChange} />);
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "morgen" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("2026-08-28");
    expect(input).toHaveValue("28.08.2026");

    fireEvent.change(input, { target: { value: "2w" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith("2026-09-10");
    vi.useRealTimers();
  });

  it("keeps invalid text visible and does not change the value", () => {
    const onChange = vi.fn();
    render(<HumanDateInput id="date" value="2026-08-28" onChange={onChange} />);
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "irgendwann vielleicht" } });
    fireEvent.blur(input);

    expect(input).toHaveValue("irgendwann vielleicht");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Datum nicht erkannt");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears an existing value and accepts the native calendar selection", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <HumanDateInput id="date" value="2026-08-28" onChange={onChange} />,
    );
    const input = screen.getByRole("textbox");

    await userEvent.clear(input);
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(null);

    const picker = container.querySelector('input[type="date"]');
    expect(picker).not.toBeNull();
    fireEvent.change(picker!, { target: { value: "2026-09-12" } });
    expect(onChange).toHaveBeenLastCalledWith("2026-09-12");
    expect(input).toHaveValue("12.09.2026");
  });

  it("offers a compact accessible calendar action", () => {
    const onChange = vi.fn();
    render(<HumanDateInput id="date" value="" onChange={onChange} />);
    expect(
      screen.getByRole("button", { name: "Datum im Kalender wählen" }),
    ).toHaveClass("icon-action-button");
  });
});
