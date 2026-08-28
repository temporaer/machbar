import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./theme";
import { THEME_COLORS, THEME_STORAGE_KEY } from "./themePreference";
import type { ThemePreference } from "./themePreference";
import indexHtml from "../../index.html?raw";

class MatchMediaMock {
  private listeners = new Set<(event: MediaQueryListEvent) => void>();

  constructor(public matches: boolean) {}

  readonly media = "(prefers-color-scheme: dark)";
  readonly onchange = null;

  addEventListener(_type: "change", listener: (event: MediaQueryListEvent) => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "change", listener: (event: MediaQueryListEvent) => void) {
    this.listeners.delete(listener);
  }

  addListener(listener: (event: MediaQueryListEvent) => void) {
    this.listeners.add(listener);
  }

  removeListener(listener: (event: MediaQueryListEvent) => void) {
    this.listeners.delete(listener);
  }

  dispatch(matches: boolean) {
    this.matches = matches;
    const event = { matches, media: this.media } as MediaQueryListEvent;
    this.listeners.forEach((listener) => listener(event));
  }
}

function ThemeProbe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <>
      <output data-testid="theme">{theme}</output>
      <output data-testid="resolved-theme">{resolvedTheme}</output>
      <button type="button" onClick={() => setTheme("dark")}>
        dark
      </button>
    </>
  );
}

function renderThemeProvider() {
  return render(
    <ThemeProvider>
      <ThemeProbe />
    </ThemeProvider>,
  );
}

describe("ThemeProvider", () => {
  let mediaQuery: MatchMediaMock;

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
    document.querySelector('meta[name="theme-color"]')?.remove();
    mediaQuery = new MatchMediaMock(false);
    vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
    document.querySelector('meta[name="theme-color"]')?.remove();
  });

  it("defaults to the live system theme and updates document metadata", () => {
    mediaQuery.matches = true;
    renderThemeProvider();

    expect(screen.getByTestId("theme")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      THEME_COLORS.dark,
    );

    act(() => mediaQuery.dispatch(false));

    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("uses and persists an explicit preference instead of system changes", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    mediaQuery.matches = true;
    renderThemeProvider();

    expect(screen.getByTestId("theme")).toHaveTextContent("light");
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("light");

    fireEvent.click(screen.getByRole("button", { name: "dark" }));

    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    act(() => mediaQuery.dispatch(false));
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");
  });

  it("synchronizes preference changes from other tabs", () => {
    renderThemeProvider();

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: THEME_STORAGE_KEY,
          newValue: "dark" satisfies ThemePreference,
        }),
      );
    });

    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: THEME_STORAGE_KEY,
          newValue: null,
        }),
      );
    });

    expect(screen.getByTestId("theme")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("light");
  });

  it("initializes the stored theme in the document head before React starts", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    document.head.insertAdjacentHTML(
      "beforeend",
      `<meta name="theme-color" content="${THEME_COLORS.light}">`,
    );
    const initializer = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

    expect(initializer).toBeDefined();
    new Function(initializer ?? "")();

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      THEME_COLORS.dark,
    );
  });
});
