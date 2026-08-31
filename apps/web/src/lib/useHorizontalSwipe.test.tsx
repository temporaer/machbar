import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHorizontalSwipe } from "./useHorizontalSwipe";

function Harness({
  disabled = false,
  onPrimary = vi.fn(),
  onSecondary = vi.fn(),
  onRealDrag,
  onClick = vi.fn(),
}: {
  disabled?: boolean;
  onPrimary?: () => void;
  onSecondary?: () => void;
  onRealDrag?: () => void;
  onClick?: () => void;
}) {
  const swipe = useHorizontalSwipe<HTMLDivElement>({
    disabled,
    onPrimary,
    onSecondary,
    ...(onRealDrag ? { onRealDrag } : {}),
  });
  return (
    <div
      data-testid="surface"
      data-drag-x={swipe.dragX}
      {...swipe.handlers}
    >
      <button type="button" onClick={onClick}>Open</button>
    </div>
  );
}

describe("useHorizontalSwipe", () => {
  it("leaves taps uncaptured and clickable", () => {
    const capture = vi.fn();
    const click = vi.fn();
    const { getByTestId, getByRole } = render(<Harness onClick={click} />);
    const surface = getByTestId("surface");
    Object.defineProperty(surface, "setPointerCapture", { value: capture });

    fireEvent.pointerDown(surface, { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 28, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 28, pointerId: 1 });
    fireEvent.click(getByRole("button", { name: "Open" }));

    expect(capture).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledOnce();
  });

  it("captures after the slop, clamps dragX, acts at the threshold, and suppresses one click", () => {
    const capture = vi.fn();
    const primary = vi.fn();
    const realDrag = vi.fn();
    const click = vi.fn();
    const { getByTestId, getByRole } = render(
      <Harness onPrimary={primary} onRealDrag={realDrag} onClick={click} />,
    );
    const surface = getByTestId("surface");
    const button = getByRole("button", { name: "Open" });
    Object.defineProperty(surface, "setPointerCapture", { value: capture });

    fireEvent.pointerDown(surface, { clientX: 0, pointerId: 7 });
    fireEvent.pointerMove(surface, { clientX: 9, pointerId: 7 });
    fireEvent.pointerMove(surface, { clientX: 200, pointerId: 7 });
    expect(surface).toHaveAttribute("data-drag-x", "140");
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(7);
    expect(realDrag).toHaveBeenCalledOnce();

    fireEvent.pointerUp(surface, { clientX: 200, pointerId: 7 });
    expect(primary).toHaveBeenCalledOnce();
    expect(surface).toHaveAttribute("data-drag-x", "0");

    fireEvent.click(button);
    fireEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
  });

  it("runs the secondary action for a completed left swipe", () => {
    const secondary = vi.fn();
    const { getByTestId } = render(<Harness onSecondary={secondary} />);
    const surface = getByTestId("surface");

    fireEvent.pointerDown(surface, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 27, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 27, pointerId: 1 });

    expect(secondary).toHaveBeenCalledOnce();
  });

  it("resets without acting on pointer cancellation and ignores disabled gestures", () => {
    const primary = vi.fn();
    const secondary = vi.fn();
    const { getByTestId, rerender } = render(
      <Harness onPrimary={primary} onSecondary={secondary} />,
    );
    const surface = getByTestId("surface");

    fireEvent.pointerDown(surface, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 100, pointerId: 1 });
    fireEvent.pointerCancel(surface, { pointerId: 1 });
    expect(surface).toHaveAttribute("data-drag-x", "0");

    rerender(
      <Harness disabled onPrimary={primary} onSecondary={secondary} />,
    );
    fireEvent.pointerDown(surface, { clientX: 0, pointerId: 2 });
    fireEvent.pointerMove(surface, { clientX: -100, pointerId: 2 });
    fireEvent.pointerUp(surface, { clientX: -100, pointerId: 2 });

    expect(primary).not.toHaveBeenCalled();
    expect(secondary).not.toHaveBeenCalled();
  });
});
