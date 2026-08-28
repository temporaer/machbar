import { de } from "./de";
import { en } from "./en";

type TranslationShape<T> = T extends (...args: infer Args) => string
  ? (...args: Args) => string
  : T extends Readonly<Record<PropertyKey, unknown>>
    ? { readonly [Key in keyof T]: TranslationShape<T[Key]> }
    : T extends string
      ? string
      : T;

export const supportedLocales = ["de", "en"] as const;
export type Locale = (typeof supportedLocales)[number];
export type TranslationCatalog = TranslationShape<typeof de>;

export const catalogs = {
  de,
  en,
} as const satisfies Record<Locale, TranslationCatalog>;

export function getCatalog(locale: Locale): TranslationCatalog {
  return catalogs[locale];
}
