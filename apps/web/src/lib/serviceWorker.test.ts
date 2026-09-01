import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function serviceWorker(initialState: ServiceWorkerState) {
  let state = initialState;
  const listeners = new Set<() => void>();
  return {
    get state() {
      return state;
    },
    addEventListener: vi.fn((_event: string, listener: () => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_event: string, listener: () => void) => {
      listeners.delete(listener);
    }),
    transition(nextState: ServiceWorkerState) {
      state = nextState;
      listeners.forEach((listener) => listener());
    },
  };
}

describe("ensureLatestServiceWorkerRegistration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  it("updates the registration and returns immediately without a new worker", async () => {
    const registration = {
      installing: null,
      waiting: null,
      update: vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: vi.fn().mockResolvedValue(registration),
        ready: Promise.resolve(registration),
      },
    });

    const { ensureLatestServiceWorkerRegistration } =
      await import("./serviceWorker");
    await expect(ensureLatestServiceWorkerRegistration()).resolves.toBe(registration);
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("waits for an installing worker to become active", async () => {
    const worker = serviceWorker("installing");
    const registration = {
      installing: worker,
      waiting: null,
      update: vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: vi.fn().mockResolvedValue(registration),
        ready: Promise.resolve(registration),
      },
    });

    const { ensureLatestServiceWorkerRegistration } =
      await import("./serviceWorker");
    const result = ensureLatestServiceWorkerRegistration();
    await vi.waitFor(() =>
      expect(worker.addEventListener).toHaveBeenCalledWith(
        "statechange",
        expect.any(Function),
      ),
    );
    worker.transition("activated");

    await expect(result).resolves.toBe(registration);
  });
});
