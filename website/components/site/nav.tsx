import Link from "next/link";
import { site } from "@/site.config";
import { Search } from "./search";

export function SiteNav() {
  return <header className="site-header"><nav className="site-nav" aria-label="Main navigation">
    <Link href="/" className="site-wordmark" aria-label={site.name}><span className="logo-mark">aap</span><span className="wordmark-name">Agent Approval<br />Protocol</span></Link>
    <div className="site-nav-links"><span className="version-label">Version {site.version}</span><Search /><a href={site.repository}>GitHub <span aria-hidden>↗</span></a></div>
  </nav></header>;
}
