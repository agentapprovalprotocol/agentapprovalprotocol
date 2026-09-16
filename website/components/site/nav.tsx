"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { site } from "@/site.config";

export function SiteNav() {
  const reference = usePathname().startsWith("/docs/reference/");
  return <header className="docs-topbar">
    <nav aria-label="Main navigation" className="docs-section-tabs">
      <Link href="/docs/specification/overview" aria-current={!reference ? "page" : undefined}>Documentation</Link>
      <Link href="/docs/reference/overview" aria-current={reference ? "page" : undefined}>API reference</Link>
    </nav>
    <span className="docs-version">Version {site.version}</span>
  </header>;
}
