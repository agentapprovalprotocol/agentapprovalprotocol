"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { VersionSelect } from "./version-select";

export function SiteNav({ children }: { children: ReactNode }) {
  const specification = usePathname().startsWith("/specification");
  return <header className="docs-topbar">
    <nav aria-label="Main navigation" className="docs-section-tabs">
      <Link href="/docs/getting-started/introduction" aria-current={!specification ? "page" : undefined}>Documentation</Link>
      <Link href="/specification/overview" aria-current={specification ? "page" : undefined}>Specification</Link>
    </nav>
    <div className="docs-topbar-actions">
      {specification && <VersionSelect />}
      {children}
    </div>
  </header>;
}
