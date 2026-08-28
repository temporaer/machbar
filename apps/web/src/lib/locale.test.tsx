import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LOCALE_STORAGE_KEY,
  LocaleProvider,
  localeFromLanguages,
  useLocale,
} from "./locale";

describe("locale preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = "de";
    document.title = "";
    document
      .querySelectorAll('meta[name="description"], link[rel="manifest"]')
      .forEach((element) => element.remove());
  });

  it("uses the first supported browser language and falls back to German", () => {
    expect(localeFromLanguages(["fr-FR", "en-GB", "de-DE"])).toBe("en");
    expect(localeFromLanguages(["de-CH", "en-US"])).toBe("de");
    expect(localeFromLanguages(["fr-FR"])).toBe("de");
  });

  it("persists changes and immediately updates strings and document metadata", () => {
    const description = document.createElement("meta");
    description.name = "description";
    document.head.append(description);
    const manifest = document.createElement("link");
    manifest.rel = "manifest";
    document.head.append(manifest);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LocaleProvider initialLocale="de">{children}</LocaleProvider>
    );
    const { result } = renderHook(() => useLocale(), { wrapper });

    act(() => result.current.setLocale("en"));

    expect(result.current.locale).toBe("en");
    expect(result.current.strings.more).toBe("More");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Machbar");
    expect(description.content).toBe("Machbar – We can do this.");
    expect(manifest.href).toMatch(/manifest\.en\.webmanifest$/);
  });

  it("synchronizes a valid preference from another tab", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LocaleProvider initialLocale="de">{children}</LocaleProvider>
    );
    const { result } = renderHook(() => useLocale(), { wrapper });

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: LOCALE_STORAGE_KEY,
          newValue: "en",
          storageArea: window.localStorage,
        }),
      );
    });

    expect(result.current.locale).toBe("en");
    expect(result.current.strings.today).toBe("Today");
  });
});
