"use client";

import * as React from "react";
import {
  applyTheme,
  readServerPreference,
  readStoredPreference,
  resolveTheme,
  setPreference,
  subscribe,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

interface ThemeContextValue {
  /** The stored preference: light, dark, or system. */
  theme: ThemePreference;
  /** What is actually on screen. */
  resolvedTheme: ResolvedTheme;
  setTheme: (preference: ThemePreference) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

/* Mounted once in the root layout. The pre-paint script there has already
 * stamped data-theme, so this only keeps it in step with later changes:
 * the toggle, another tab, or the OS flipping while the preference is
 * system. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = React.useSyncExternalStore(
    subscribe,
    readStoredPreference,
    readServerPreference
  );
  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme>("light");

  React.useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyTheme(resolved);
    if (theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next: ResolvedTheme = query.matches ? "dark" : "light";
      setResolvedTheme(next);
      applyTheme(next);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [theme]);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme: setPreference }),
    [theme, resolvedTheme]
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const value = React.useContext(ThemeContext);
  if (!value) throw new Error("useTheme requires a ThemeProvider");
  return value;
}
