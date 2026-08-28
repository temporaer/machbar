import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  DISCONNECTED_POLL_MS,
  RefreshProvider,
  useRefresh,
} from "./refresh";

vi.mock("./api", () => ({
  changeStreamUrl: () => "/api/changes?clientId=tab-a",
}));

vi.mock("./clientId", () => ({
  getClientId: () => "tab-a",
}));

vi.mock("./identity", () => ({
  useIdentity: () => ({
    authEnabled: false,
    authenticated: false,
    authLoading: false,
  }),
}));

class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }
}

function Version({ children }: { children?: ReactNode }) {
  const { version } = useRefresh();
  return (
    <div>
      <output aria-label="version">{version}</output>
      {children}
    </div>
  );
}

describe("RefreshProvider synchronization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("refreshes for remote events but ignores the current tab's events", () => {
    render(
      <RefreshProvider remoteSyncEnabled>
        <Version />
      </RefreshProvider>,
    );
    const stream = MockEventSource.instances[0]!;

    act(() => {
      stream.onopen?.();
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByLabelText("version")).toHaveTextContent("1");

    act(() => {
      stream.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ originClientId: "tab-a" }),
        }),
      );
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByLabelText("version")).toHaveTextContent("1");

    act(() => {
      stream.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ originClientId: "tab-b" }),
        }),
      );
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByLabelText("version")).toHaveTextContent("2");
  });

  it("polls only while the stream is disconnected and the page is visible", () => {
    render(
      <RefreshProvider remoteSyncEnabled>
        <Version />
      </RefreshProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(DISCONNECTED_POLL_MS + 150);
    });
    expect(screen.getByLabelText("version")).toHaveTextContent("1");

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.onopen?.();
      vi.advanceTimersByTime(150);
    });
    act(() => {
      vi.advanceTimersByTime(DISCONNECTED_POLL_MS);
    });
    expect(screen.getByLabelText("version")).toHaveTextContent("2");

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      stream.onerror?.();
      vi.advanceTimersByTime(DISCONNECTED_POLL_MS + 150);
    });
    expect(screen.getByLabelText("version")).toHaveTextContent("2");
  });

  it("coalesces focus and visibility refreshes and closes the stream", () => {
    const rendered = render(
      <RefreshProvider remoteSyncEnabled>
        <Version />
      </RefreshProvider>,
    );
    const stream = MockEventSource.instances[0]!;

    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByLabelText("version")).toHaveTextContent("1");

    rendered.unmount();
    expect(stream.close).toHaveBeenCalledOnce();
  });
});
