import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SWIPE_COACH_STORAGE_KEY,
  SwipeCoachProvider,
  useSwipeCoach,
} from "./swipeCoach";

function mockMatchMedia({
  coarse = true,
  reducedMotion = false,
}: {
  coarse?: boolean;
  reducedMotion?: boolean;
} = {}) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(pointer: coarse)" ? coarse : reducedMotion,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function Candidate({ id }: { id: string }) {
  const coach = useSwipeCoach(id);
  return (
    <div
      data-testid={id}
      data-active={coach.active}
      data-animate={coach.animate}
    >
      {coach.active ? (
        <button type="button" onClick={coach.dismiss}>
          dismiss
        </button>
      ) : null}
    </div>
  );
}

function renderCandidates() {
  return render(
    <SwipeCoachProvider>
      <Candidate id="first" />
      <Candidate id="second" />
    </SwipeCoachProvider>,
  );
}

describe("SwipeCoachProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("assigns the lesson to only the first eligible row and persists dismissal", async () => {
    mockMatchMedia();
    const firstRender = renderCandidates();

    await waitFor(() =>
      expect(screen.getByTestId("first")).toHaveAttribute("data-active", "true"),
    );
    expect(screen.getByTestId("second")).toHaveAttribute("data-active", "false");

    fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
    expect(window.localStorage.getItem(SWIPE_COACH_STORAGE_KEY)).toBe("seen");
    firstRender.unmount();

    renderCandidates();
    expect(screen.getByTestId("first")).toHaveAttribute("data-active", "false");
    expect(screen.queryByRole("button", { name: "dismiss" })).not.toBeInTheDocument();
  });

  it("does not offer the lesson on fine pointers", () => {
    mockMatchMedia({ coarse: false });
    renderCandidates();

    expect(screen.getByTestId("first")).toHaveAttribute("data-active", "false");
  });

  it("keeps the static hint but disables preview motion for reduced motion", async () => {
    mockMatchMedia({ reducedMotion: true });
    renderCandidates();

    await waitFor(() =>
      expect(screen.getByTestId("first")).toHaveAttribute("data-active", "true"),
    );
    expect(screen.getByTestId("first")).toHaveAttribute("data-animate", "false");
  });
});
