"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

/* Copies the text of the <pre> inside the enclosing .docs-code frame. Reads
 * the DOM at click time so the frame never has to carry the source twice.
 * Icon only: two stacked squares, swapping to a check once copied. */
export function CopyButton() {
  const [copied, setCopied] = React.useState(false);
  const ref = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const onClick = async () => {
    const pre = ref.current?.closest(".docs-code")?.querySelector("pre");
    if (!pre) return;
    try {
      await navigator.clipboard.writeText(pre.innerText);
      setCopied(true);
    } catch {
      /* Clipboard access denied: leave the icon alone. */
    }
  };

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={copied ? "Copied" : "Copy code"}
      title={copied ? "Copied" : "Copy"}
      aria-live="polite"
      className={cn(
        "flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink",
        copied
          ? "text-approve-ink"
          : "text-ink-faint hover:bg-fill-strong hover:text-ink",
      )}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3.5">
          <path
            d="M3 8.5l3 3 7-7"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3.5">
          <rect
            x="5.5"
            y="5.5"
            width="8"
            height="8"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.25"
          />
          <path
            d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
