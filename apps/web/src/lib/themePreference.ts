export const THEME_STORAGE_KEY = "machbar:theme";
export const THEME_COLOR_META_NAME = "theme-color";
export const THEME_COLORS = {
  light: "#146356",
  dark: "#101815",
} as const;

export const themePreferences = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof themePreferences)[number];
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (themePreferences as readonly string[]).includes(value);
}

export function readStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function readSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";

  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function resolveTheme(
  preference: ThemePreference,
  systemTheme: ResolvedTheme,
): ResolvedTheme {
  return preference === "system" ? systemTheme : preference;
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;

  let themeColor = document.querySelector<HTMLMetaElement>(
    `meta[name="${THEME_COLOR_META_NAME}"]`,
  );
  if (!themeColor) {
    themeColor = document.createElement("meta");
    themeColor.name = THEME_COLOR_META_NAME;
    document.head.append(themeColor);
  }
  themeColor.content = THEME_COLORS[theme];
}
