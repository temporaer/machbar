import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  getCatalog,
  supportedLocales,
  type Locale,
  type TranslationCatalog,
} from "./catalog";
import { de } from "./de";

export const LOCALE_STORAGE_KEY = "machbar:locale";
export const DEFAULT_LOCALE: Locale = "de";

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (supportedLocales as readonly string[]).includes(value)
  );
}

export function localeFromLanguages(
  languages: readonly string[] | undefined,
): Locale {
  for (const language of languages ?? []) {
    const baseLanguage = language.trim().toLowerCase().split("-")[0];
    if (isLocale(baseLanguage)) return baseLanguage;
  }
  return DEFAULT_LOCALE;
}

export function readStoredLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

function browserLanguages(): readonly string[] | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.languages.length > 0
    ? navigator.languages
    : navigator.language
      ? [navigator.language]
      : undefined;
}

export function resolveInitialLocale(): Locale {
  const stored = readStoredLocale();
  if (stored) return stored;
  return localeFromLanguages(browserLanguages());
}

interface LocaleContextValue {
  locale: Locale;
  strings: TranslationCatalog;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);
const fallbackLocaleContext: LocaleContextValue = {
  locale: DEFAULT_LOCALE,
  strings: de,
  setLocale: () => undefined,
};

function applyDocumentLocale(
  locale: Locale,
  strings: TranslationCatalog,
): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.title = strings.documentTitle;

  const description = document.querySelector<HTMLMetaElement>(
    'meta[name="description"]',
  );
  if (description) description.content = strings.metaDescription;

  const manifest = document.querySelector<HTMLLinkElement>(
    'link[rel="manifest"]',
  );
  if (manifest) {
    manifest.href = `${import.meta.env.BASE_URL}manifest.${locale}.webmanifest`;
  }
}

export function LocaleProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(
    () => initialLocale ?? resolveInitialLocale(),
  );
  const strings = getCatalog(locale);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // Keep the in-memory preference when browser storage is unavailable.
    }
  }, []);

  useEffect(() => {
    applyDocumentLocale(locale, strings);
  }, [locale, strings]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LOCALE_STORAGE_KEY) return;
      if (
        event.storageArea !== null &&
        event.storageArea !== window.localStorage
      ) {
        return;
      }
      setLocaleState(
        isLocale(event.newValue)
          ? event.newValue
          : localeFromLanguages(browserLanguages()),
      );
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo(
    () => ({ locale, strings, setLocale }),
    [locale, setLocale, strings],
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext) ?? fallbackLocaleContext;
}

/**
 * German is a deterministic fallback for isolated component tests. The
 * application itself always mounts LocaleProvider, so browser preferences
 * and live changes flow through context without mutable module state.
 */
export function useStrings(): TranslationCatalog {
  return useContext(LocaleContext)?.strings ?? de;
}
