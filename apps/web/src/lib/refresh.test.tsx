import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  DISCONNECTED_POLL_MS,
  EXTERNAL_REFRESH_INTERVAL_MS,
  RefreshProvider,
  TIMED_ELIGIBILITY_REFRESH_MS,
  useRefresh,
  useVisibleRefreshInterval,
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

function VisibleInterval({ refresh }: { refresh: () => void }) {
  useVisibleRefreshInterval(refresh);
  return null;
}

describe("RefreshProvider synchronization", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
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
    vi.restoreAllMocks();
    window.sessionStorage.clear();
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
      vi.advanceTimersByTime(EXTERNAL_REFRESH_INTERVAL_MS);
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
    expect(vi.getTimerCount()).toBe(0);
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it("runs timed eligibility refreshes only while the page is visible", () => {
    const refresh = vi.fn();
    render(
      <RefreshProvider>
        <VisibleInterval refresh={refresh} />
      </RefreshProvider>,
    );

    act(() => vi.advanceTimersByTime(TIMED_ELIGIBILITY_REFRESH_MS));
    expect(refresh).toHaveBeenCalledOnce();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => vi.advanceTimersByTime(TIMED_ELIGIBILITY_REFRESH_MS));
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("bounds sustained mixed external events and delivers the final trailing refresh", () => {
    const rendered = render(<RefreshProvider remoteSyncEnabled><Version /></RefreshProvider>);
    const stream = MockEventSource.instances[0]!;
    act(() => stream.onopen?.());
    for (let index = 0; index < 13; index++) {
      act(() => {
        vi.advanceTimersByTime(200);
        stream.onmessage?.(new MessageEvent("message", { data: '{"originClientId":"other"}' }));
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("online"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }
    expect(screen.getByLabelText("version")).toHaveTextContent("3");
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByLabelText("version")).toHaveTextContent("4");
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByLabelText("version")).toHaveTextContent("4");
    rendered.rerender(<RefreshProvider remoteSyncEnabled><Version /></RefreshProvider>);
    expect(MockEventSource.instances).toHaveLength(1);
    rendered.unmount();
    expect(stream.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves immediate mutation refreshes during an external cooldown and refreshes on reconnect", () => {
    let bump!: () => void;
    function Mutation() { bump = useRefresh().bump; return <Version />; }
    render(<RefreshProvider remoteSyncEnabled><Mutation /></RefreshProvider>);
    const stream = MockEventSource.instances[0]!;
    act(() => stream.onopen?.());
    act(() => window.dispatchEvent(new Event("focus")));
    act(() => bump());
    expect(screen.getByLabelText("version")).toHaveTextContent("2");
    act(() => vi.advanceTimersByTime(EXTERNAL_REFRESH_INTERVAL_MS));
    expect(screen.getByLabelText("version")).toHaveTextContent("3");
    act(() => stream.onerror?.());
    act(() => vi.advanceTimersByTime(EXTERNAL_REFRESH_INTERVAL_MS));
    act(() => stream.onopen?.());
    expect(screen.getByLabelText("version")).toHaveTextContent("4");
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("keeps incident diagnostics opt-in and excludes remote payloads", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    render(<RefreshProvider remoteSyncEnabled><Version /></RefreshProvider>);
    const stream = MockEventSource.instances[0]!;
    act(() => stream.onopen?.());
    expect(debug).not.toHaveBeenCalled();
    window.sessionStorage.setItem("machbar:refresh-debug", "1");
    act(() => {
      stream.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({ originClientId: "another-tab", title: "private content" }),
      }));
      vi.advanceTimersByTime(EXTERNAL_REFRESH_INTERVAL_MS);
      stream.onerror?.();
    });
    expect(debug.mock.calls.map((call) => call[1].reason)).toEqual([
      "remote-change", "external-trailing", "sse-error",
    ]);
    for (const [, diagnostic] of debug.mock.calls) {
      expect(Object.keys(diagnostic)).toEqual(["reason", "version", "time"]);
      expect(diagnostic.version).toBeGreaterThanOrEqual(1);
      expect(diagnostic.time).toEqual(expect.any(Number));
    }
    expect(JSON.stringify(debug.mock.calls)).not.toContain("private content");
  });

});
