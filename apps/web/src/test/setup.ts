import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(String(key)) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(String(key)); }
  setItem(key: string, value: string) { this.values.set(String(key), String(value)); }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  if (typeof window[name] === "undefined") {
    Object.defineProperty(window, name, { configurable: true, value: new MemoryStorage() });
  }
}

if (typeof window.StorageEvent === "undefined" || window.localStorage instanceof MemoryStorage) {
  class StorageEventPolyfill extends Event {
    readonly key: string | null;
    readonly oldValue: string | null;
    readonly newValue: string | null;
    readonly url: string;
    readonly storageArea: Storage | null;
    constructor(type: string, init: StorageEventInit = {}) {
      super(type, init);
      this.key = init.key ?? null;
      this.oldValue = init.oldValue ?? null;
      this.newValue = init.newValue ?? null;
      this.url = init.url ?? window.location.href;
      this.storageArea = init.storageArea ?? null;
    }
  }
  Object.defineProperty(window, "StorageEvent", { configurable: true, value: StorageEventPolyfill });
  Object.defineProperty(globalThis, "StorageEvent", { configurable: true, value: StorageEventPolyfill });
}

afterEach(() => {
  cleanup();
  if (typeof window !== "undefined") window.sessionStorage.clear();
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

// CodeMirror measures DOM ranges; jsdom has no layout implementation.
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
