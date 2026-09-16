/* Theme preference and resolution for the AAP website. "system" follows
 * prefers-color-scheme; "light" and "dark" are stored overrides. The
 * resolved theme is stamped on <html> as data-theme, which the token block
 * in app/globals.css and the Tailwind dark variant both read. */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "aap-theme";

const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: "#f9f9f8",
  dark: "#0b0d13",
};

export function readStoredPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

/* Server snapshot for useSyncExternalStore: the toggle renders "system"
 * during hydration and re-renders to the stored value right after. */
export function readServerPreference(): ThemePreference {
  return "system";
}

export function storePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* storage unavailable */
  }
}

export function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.setAttribute("data-theme", resolved);
  /* The layout declares a theme-color pair keyed on the media query; a
   * stored override has to win over it for the browser chrome too. */
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => {
      meta.content = THEME_COLORS[resolved];
    });
}

/* A minimal external store so every subscriber sees one preference,
 * and other tabs follow along via
 * the storage event. */
const listeners = new Set<() => void>();

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function setPreference(preference: ThemePreference): void {
  storePreference(preference);
  applyTheme(resolveTheme(preference));
  listeners.forEach((listener) => listener());
}
