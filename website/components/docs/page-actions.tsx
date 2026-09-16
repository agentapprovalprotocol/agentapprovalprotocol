"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

/* "Copy page" and "View as Markdown", the way Stripe's docs offer them.
 * Copy fetches the page's Markdown twin and puts it on the clipboard, for
 * pasting into an LLM; View opens the twin in a new tab. */
export function PageActions({ markdownPath }: { markdownPath: string }) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");

  React.useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      const res = await fetch(markdownPath);
      if (!res.ok) throw new Error(String(res.status));
      await navigator.clipboard.writeText(await res.text());
      setState("copied");
    } catch {
      setState("failed");
    }
  };

  const item =
    "inline-flex cursor-pointer items-center gap-x-1.5 px-2.5 py-1.5 text-[0.8125rem] leading-none text-ink-soft transition-colors duration-200 hover:bg-fill hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink";

  return (
    <div className="inline-flex overflow-hidden rounded-lg border-[0.5px] border-edge-strong bg-surface">
      <button
        type="button"
        onClick={copy}
        aria-live="polite"
        className={cn(item, state === "copied" && "text-approve-ink", state === "failed" && "text-deny-strong")}
      >
        {state === "copied" ? (
          <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3.5">
            <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3.5">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
            <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
        )}
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy page"}
      </button>
      <a
        href={markdownPath}
        target="_blank"
        rel="noreferrer"
        className={cn(item, "border-l-[0.5px] border-edge-strong")}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3.5">
          <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
          <path d="M5 10V6l1.75 2L8.5 6v4M10.5 6v4m-1.25-1.25L10.5 10l1.25-1.25" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        View as Markdown
      </a>
    </div>
  );
}
