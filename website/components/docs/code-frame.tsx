import type { ReactNode } from "react";
import { CopyButton } from "./copy-button";

/* Shared frame for highlighted code and client-rendered diagram source. */
export function CodeFrame({
  lang,
  title,
  children,
}: {
  lang?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <figure className="docs-code">
      <div className="docs-code-header">
        {title ? (
          <span className="font-mono text-[0.75rem] text-ink-muted">{title}</span>
        ) : (
          <span className="font-sans text-[0.6875rem] uppercase tracking-[0.08em] text-ink-faint">
            {lang ?? "text"}
          </span>
        )}
        <CopyButton />
      </div>
      {children}
    </figure>
  );
}
