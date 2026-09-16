"use client";

import * as React from "react";
import { MethodPill } from "@/components/docs/api/method-pill";
import type { TocItem } from "@/lib/content";

export function Toc({ items }: { items: TocItem[] }) {
  const [activeId, setActiveId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (items.length === 0) return;
    const headings = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
            return;
          }
        }
      },
      /* Fire when a heading crosses the band just below the sticky nav. */
      { rootMargin: "-96px 0px -70% 0px" },
    );
    headings.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <nav aria-label="Table of contents">
      <div className="mb-3.5 text-[0.8125rem] font-medium text-ink-soft">
        On this page
      </div>
      <ul className="flex flex-col gap-y-2.5 border-l-[0.5px] border-edge">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className={`-ml-px block border-l py-0.5 leading-[1.45] transition-colors ${
                item.code
                  ? "font-mono text-[0.75rem] [overflow-wrap:anywhere]"
                  : "text-[0.8125rem]"
              } ${item.level === 3 ? "pl-7" : "pl-4"} ${
                activeId === item.id
                  ? "border-ink text-ink"
                  : "border-transparent text-ink-muted hover:text-ink"
              }`}
            >
              {item.method ? (
                /* Pill in its own column so a wrapped path lines up under
                 * its own first line, not under the pill. */
                <span className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2">
                  <span className="pt-[0.1875rem]">
                    <MethodPill method={item.method} size="sm" />
                  </span>
                  <span>{tocPath(item.title)}</span>
                </span>
              ) : (
                item.title
              )}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* API reference entries share the /api/v1 prefix; the heading keeps the
 * full path, the rail drops the prefix so the part that differs fits. */
function tocPath(path: string): string {
  return path.replace(/^\/api\/v1(?=\/)/, "");
}
