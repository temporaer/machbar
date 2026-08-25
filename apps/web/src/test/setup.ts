import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// jsdom does not implement PointerEvent, which breaks any swipe/drag gesture
// simulated via @testing-library's fireEvent.pointer* helpers (clientX/pointerId
// are silently dropped because it falls back to the base Event constructor).
// Polyfill a minimal PointerEvent on top of MouseEvent so tests can simulate
// touch/pointer swipe gestures realistically.
if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    public pointerId: number;
    public pointerType: string;
    public isPrimary: boolean;

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "touch";
      this.isPrimary = params.isPrimary ?? true;
    }
  }

  // @ts-expect-error jsdom does not implement PointerEvent
  window.PointerEvent = PointerEventPolyfill;
}
