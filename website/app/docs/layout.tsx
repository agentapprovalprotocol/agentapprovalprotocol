import { DocsSidebar } from "@/components/docs/sidebar";
import { getDocsNav } from "@/lib/docs";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <main id="main-content" className="mx-auto max-w-[100rem] px-6 md:px-10"><div className="pb-20 pt-8 md:pt-12 lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-12">
    <div><DocsSidebar nav={getDocsNav()} /></div><div className="min-w-0">{children}</div>
  </div></main>;
}
