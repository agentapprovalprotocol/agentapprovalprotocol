"use client";

import * as React from "react";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { cn } from "@/lib/cn";
import type { ThemePreference } from "@/lib/theme";
import { MonitorIcon, MoonIcon, SunIcon } from "./theme-icons";
import { useTheme } from "./theme-provider";

const OPTIONS: {
  value: ThemePreference;
  label: string;
  Icon: typeof SunIcon;
}[] = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
];

/* Three-way segmented control for the color theme. Exactly one segment is
 * always pressed: clicking the active one again does not empty the group. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  return (
    <ToggleGroup
      aria-label="Color theme"
      value={[theme]}
      onValueChange={(values) => {
        const next = values[values.length - 1];
        if (next === "light" || next === "dark" || next === "system") {
          setTheme(next);
        }
      }}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border-[0.5px] border-edge bg-surface p-0.5",
        className
      )}
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <Toggle
          key={value}
          value={value}
          aria-label={label}
          title={label}
          className={cn(
            "flex h-7 min-w-8 cursor-pointer items-center justify-center rounded-md px-1.5 text-ink-muted transition-colors duration-200",
            "hover:bg-fill hover:text-ink",
            "data-pressed:bg-fill-strong data-pressed:text-ink data-pressed:shadow-hairline",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
          )}
        >
          <Icon />
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
