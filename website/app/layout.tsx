import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { ThemeProvider } from "@/components/site/theme-provider";
import { ThemeToggle } from "@/components/site/theme-toggle";
import { SiteNav } from "@/components/site/nav";
import { site } from "@/site.config";
import "./globals.css";
import "./site.css";

export const metadata: Metadata = {
  metadataBase: new URL(site.url), title: { default: site.name, template: `%s · AAP` },
  description: site.description, alternates: { canonical: "/" },
  openGraph: { title: site.name, description: site.description, siteName: site.name, type: "website" },
};
export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f9f9f8" }, { media: "(prefers-color-scheme: dark)", color: "#0b0d13" }] };
const themeScript = `(function(){try{var p=localStorage.getItem('aap-theme');var t=p==='dark'||p==='light'?p:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head><body>
    <ThemeProvider><a href="#main-content" className="skip-link">Skip to content</a><SiteNav />{children}
      <footer className="site-footer"><div><span>{site.name}</span><span className="footer-note">A shared contract for agent approvals.</span></div><div className="footer-actions"><Link href="/openapi.yaml">OpenAPI</Link><a href={site.repository}>GitHub</a><ThemeToggle /></div></footer>
    </ThemeProvider>
  </body></html>;
}
