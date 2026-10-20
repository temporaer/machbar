import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHorizontalSwipe } from "./useHorizontalSwipe";

function Harness({
  disabled = false,
  onPrimary = vi.fn(),
  onSecondary = vi.fn(),
  onDeepPrimary,
  onRealDrag,
  onClick = vi.fn(),
}: {
  disabled?: boolean;
  onPrimary?: () => void;
  onSecondary?: () => void;
  onDeepPrimary?: () => void;
  onRealDrag?: () => void;
  onClick?: () => void;
}) {
  const swipe = useHorizontalSwipe<HTMLDivElement>({
    disabled,
    onPrimary,
    onSecondary,
    ...(onDeepPrimary ? { onDeepPrimary } : {}),
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

  it("runs the primary action for an ~80px right swipe and suppresses one click", () => {
    const capture = vi.fn();
    const primary = vi.fn();
    const deepPrimary = vi.fn();
    const realDrag = vi.fn();
    const click = vi.fn();
    const { getByTestId, getByRole } = render(
      <Harness
        onPrimary={primary}
        onDeepPrimary={deepPrimary}
        onRealDrag={realDrag}
        onClick={click}
      />,
    );
    const surface = getByTestId("surface");
    const button = getByRole("button", { name: "Open" });
    Object.defineProperty(surface, "setPointerCapture", { value: capture });

    fireEvent.pointerDown(surface, { clientX: 0, pointerId: 7 });
    fireEvent.pointerMove(surface, { clientX: 9, pointerId: 7 });
    fireEvent.pointerMove(surface, { clientX: 80, pointerId: 7 });
    expect(surface).toHaveAttribute("data-drag-x", "80");
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(7);
    expect(realDrag).toHaveBeenCalledOnce();

    fireEvent.pointerUp(surface, { clientX: 80, pointerId: 7 });
    expect(primary).toHaveBeenCalledOnce();
    expect(deepPrimary).not.toHaveBeenCalled();
    expect(surface).toHaveAttribute("data-drag-x", "0");

    fireEvent.click(button, { detail: 1 });
    fireEvent.click(button, { detail: 1 });
    expect(click).toHaveBeenCalledOnce();
  });

  it("never suppresses keyboard activation after a swipe without a trailing pointer click", () => {
    const click = vi.fn();
    const { getByTestId, getByRole } = render(<Harness onClick={click} />);
    const surface = getByTestId("surface");
    const button = getByRole("button");
    fireEvent.pointerDown(surface, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 20, pointerId: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    fireEvent.click(button, { detail: 0 });
    expect(click).toHaveBeenCalledOnce();
    fireEvent.click(button, { detail: 1 });
    expect(click).toHaveBeenCalledOnce();
  });

  it("runs the deep primary action for an ~140px right swipe instead of the normal primary action", () => {
    const primary = vi.fn();
    const deepPrimary = vi.fn();
    const { getByTestId } = render(
      <Harness onPrimary={primary} onDeepPrimary={deepPrimary} />,
    );
    const surface = getByTestId("surface");

    fireEvent.pointerDown(surface, { clientX: 0, pointerId: 3 });
    fireEvent.pointerMove(surface, { clientX: 140, pointerId: 3 });
    expect(surface).toHaveAttribute("data-drag-x", "140");
    fireEvent.pointerUp(surface, { clientX: 140, pointerId: 3 });

    expect(deepPrimary).toHaveBeenCalledOnce();
    expect(primary).not.toHaveBeenCalled();
  });

  it("runs the secondary action for a completed left swipe", () => {
    const secondary = vi.fn();
    const { getByTestId } = render(<Harness onSecondary={secondary} />);
    const surface = getByTestId("surface");

    fireEvent.pointerDown(surface, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 20, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 20, pointerId: 1 });

    expect(secondary).toHaveBeenCalledOnce();
  });

  it("locks out vertical gestures without capturing or suppressing clicks", () => {
    const primary = vi.fn();
    const click = vi.fn();
    const capture = vi.fn();
    const { getByTestId, getByRole } = render(<Harness onPrimary={primary} onClick={click} />);
    const surface = getByTestId("surface");
    Object.defineProperty(surface, "setPointerCapture", { value: capture });
    fireEvent.pointerDown(surface, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 5, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 100, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    fireEvent.click(getByRole("button"));
    expect(surface).toHaveAttribute("data-drag-x", "0");
    expect(capture).not.toHaveBeenCalled();
    expect(primary).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight drag when disabled and does not resume it when re-enabled", () => {
    const primary = vi.fn();
    const { getByTestId, rerender } = render(<Harness onPrimary={primary} />);
    const surface = getByTestId("surface");
    fireEvent.pointerDown(surface, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 80, pointerId: 1 });
    expect(surface).toHaveAttribute("data-drag-x", "80");
    rerender(<Harness disabled onPrimary={primary} />);
    expect(surface).toHaveAttribute("data-drag-x", "0");
    rerender(<Harness onPrimary={primary} />);
    fireEvent.pointerMove(surface, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    expect(primary).not.toHaveBeenCalled();
  });

  it("ignores secondary pointers and non-left mouse buttons", () => {
    const primary = vi.fn();
    const { getByTestId } = render(<Harness onPrimary={primary} />);
    const surface = getByTestId("surface");
    fireEvent.pointerDown(surface, { clientX: 0, pointerId: 2, isPrimary: false });
    fireEvent.pointerMove(surface, { clientX: 100, pointerId: 2 });
    fireEvent.pointerUp(surface, { pointerId: 2 });
    fireEvent.pointerDown(surface, { clientX: 0, pointerId: 3, button: 2 });
    fireEvent.pointerMove(surface, { clientX: 100, pointerId: 3 });
    fireEvent.pointerUp(surface, { pointerId: 3 });
    expect(primary).not.toHaveBeenCalled();

    fireEvent.pointerDown(surface, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 100, pointerId: 2 });
    fireEvent.pointerUp(surface, { pointerId: 2 });
    expect(surface).toHaveAttribute("data-drag-x", "0");
    fireEvent.pointerMove(surface, { clientX: 80, pointerId: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    expect(primary).toHaveBeenCalledOnce();
  });

  it("accepts a fresh pointer sequence after an uncaptured press ends outside the surface", () => {
    const primary = vi.fn();
    const { getByTestId } = render(<Harness onPrimary={primary} />);
    const surface = getByTestId("surface");
    fireEvent.pointerDown(surface, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(document.body, { pointerId: 1 });
    fireEvent.pointerDown(surface, { clientX: 0, pointerId: 2 });
    fireEvent.pointerMove(surface, { clientX: 80, pointerId: 2 });
    fireEvent.pointerUp(surface, { pointerId: 2 });
    expect(primary).toHaveBeenCalledOnce();
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
