"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import type { DocsNavSection } from "@/lib/docs";

/* Docs sidebar: sticky rail on desktop, CSS-only <details> disclosure on
 * mobile. Active state mirrors the blog Toc: a hairline left rail with the
 * active page's border overlaid in ink. */

function SectionList({ nav, pathname }: { nav: DocsNavSection[]; pathname: string }) {
  return (
    <div className="flex flex-col gap-y-7">
      {nav.map((section) => (
        <div key={section.title}>
          <div className="mb-3 font-sans text-[0.6875rem] uppercase tracking-[0.08em] text-ink-faint">
            {section.title}
          </div>
          <ul className="flex flex-col gap-y-1 border-l-[0.5px] border-edge">
            {section.pages.map((page) => {
              const href = `/docs/${page.slug}`;
              const active = pathname === href;
              return (
                <li key={page.slug}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "-ml-px block border-l py-1 pl-4 text-[0.875rem] leading-[1.4] transition-colors",
                      active
                        ? "border-ink text-ink"
                        : "border-transparent text-ink-muted hover:text-ink",
                    )}
                  >
                    {page.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function DocsSidebar({ nav }: { nav: DocsNavSection[] }) {
  const pathname = usePathname();

  return (
    <>
      {/* Mobile: disclosure above the content. */}
      <details key={pathname} className="group mb-8 rounded-xl border-[0.5px] border-edge bg-surface lg:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3.5 text-[0.875rem] font-medium text-ink [&::-webkit-details-marker]:hidden">
          Documentation
          <svg
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
            className="size-4 text-ink-muted transition-transform duration-200 group-open:rotate-180"
          >
            <path
              d="M4 6l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </summary>
        <div className="border-t-[0.5px] border-edge px-5 py-5">
          <SectionList nav={nav} pathname={pathname} />
        </div>
      </details>

      {/* Desktop: sticky rail. */}
      <nav
        aria-label="Documentation"
        className="hidden lg:sticky lg:top-28 lg:block lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto lg:pb-8"
      >
        <SectionList nav={nav} pathname={pathname} />
      </nav>
    </>
  );
}
