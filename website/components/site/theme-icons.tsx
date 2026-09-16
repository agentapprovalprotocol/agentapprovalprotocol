import * as React from "react";

/* Sun, monitor and moon glyphs for the theme controls; 24-unit viewBox,
 * stroked in currentColor. */

type IconProps = React.SVGProps<SVGSVGElement>;

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function SunIcon(props: IconProps) {
  return (
    <svg width="14" height="14" {...base} {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </svg>
  );
}

export function MonitorIcon(props: IconProps) {
  return (
    <svg width="14" height="14" {...base} {...props}>
      <rect x="3" y="4" width="18" height="12.5" rx="2" />
      <path d="M8.5 20h7M12 16.5V20" />
    </svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <svg width="14" height="14" {...base} {...props}>
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z" />
    </svg>
  );
}
