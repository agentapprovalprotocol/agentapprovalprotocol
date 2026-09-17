"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search } from "@/components/site/search";
import { Logo } from "@/components/site/logo";
import { ThemeToggle } from "@/components/site/theme-toggle";
import type { DocsNavSection } from "@/lib/docs";
import { site } from "@/site.config";

export function DocsSidebar({ nav }: { nav: DocsNavSection[] }) {
  const pathname = usePathname();
  const area = pathname.startsWith("/specification") ? "specification" : "docs";
  const [menuOpen, setMenuOpen] = useState(false);
  const previousPath = useRef(pathname);

  useEffect(() => {
    setMenuOpen(false);
    if (previousPath.current !== pathname && !window.location.hash) {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
    previousPath.current = pathname;
  }, [pathname]);

  return <aside className="docs-rail">
    <div className="docs-brand-row">
      <Link href="/" className="site-wordmark" aria-label={site.name}>
        <Logo className="site-logo" />
      </Link>
      <button className="docs-menu-toggle" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} aria-controls="docs-navigation" onClick={() => setMenuOpen(!menuOpen)}>
        <svg viewBox="0 0 20 20" fill="none" aria-hidden><path d={menuOpen ? "M5 5l10 10M15 5L5 15" : "M3 5h14M3 10h14M3 15h14"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </div>
    <Search />
    <div id="docs-navigation" className="docs-rail-navigation" data-open={menuOpen} onKeyDown={(event) => { if (event.key === "Escape") setMenuOpen(false); }}>
      <nav aria-label={area === "specification" ? "Specification pages" : "Documentation pages"} className="docs-section-list">
        {nav.filter((section) => section.area === area).map((section) => <div key={section.title}>
          <h2>{section.title}</h2>
          <ul>{section.pages.map((page) => {
            const href = `/${page.slug}`;
            return <li key={page.slug}><Link href={href} aria-current={pathname === href ? "page" : undefined} onClick={() => setMenuOpen(false)}>{page.sidebarTitle ?? page.title}</Link></li>;
          })}</ul>
        </div>)}
      </nav>
      <footer className="docs-rail-footer">
        <a href={site.repository}>GitHub <span aria-hidden>↗</span></a>
        <Link href="/openapi.yaml">OpenAPI schema <span aria-hidden>↗</span></Link>
        <div className="docs-theme-row"><span>Appearance</span><ThemeToggle /></div>
      </footer>
    </div>
  </aside>;
}
