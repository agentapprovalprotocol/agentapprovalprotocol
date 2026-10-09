import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "@/components/site/theme-provider";
import { DocsSidebar } from "@/components/docs/sidebar";
import { SiteNav } from "@/components/site/nav";
import { GitHubButton } from "@/components/site/github-button";
import { getDocsNav } from "@/lib/docs";
import { site } from "@/site.config";
import "./globals.css";
import "./site.css";

export const metadata: Metadata = {
  metadataBase: new URL(site.url), title: { default: site.name, template: `%s · ${site.name}` },
  description: site.description, alternates: { canonical: "/" },
  openGraph: { title: site.name, description: site.description, siteName: site.name, type: "website", locale: "en_US" },
  twitter: { card: "summary_large_image" },
};
export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f9f9f8" }, { media: "(prefers-color-scheme: dark)", color: "#0b0d13" }] };
const themeScript = `(function(){try{var p=localStorage.getItem('aap-theme');var t=p==='dark'||p==='light'?p:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning><head>
    {/* Start the fonts used above the fold before the stylesheet is parsed.
        Keep these URLs aligned with the font faces in globals.css. */}
    <link
      rel="preload"
      href="/fonts/Inter-400-700.woff2"
      as="font"
      type="font/woff2"
      crossOrigin="anonymous"
    />
    <link
      rel="preload"
      href="/fonts/RobotoMono-400-500.woff2"
      as="font"
      type="font/woff2"
      crossOrigin="anonymous"
    />
    <script dangerouslySetInnerHTML={{ __html: themeScript }} />
  </head><body>
    <ThemeProvider><a href="#main-content" className="skip-link">Skip to content</a>
      <DocsSidebar nav={getDocsNav()} />
      <div className="docs-workspace"><SiteNav><GitHubButton /></SiteNav><main id="main-content" className="docs-main">{children}</main></div>
    </ThemeProvider>
  </body></html>;
}
