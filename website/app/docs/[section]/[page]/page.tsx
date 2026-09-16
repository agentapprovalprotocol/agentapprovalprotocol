import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Toc } from "@/components/blog/toc";
import { Markdown } from "@/components/docs/markdown";
import { PageActions } from "@/components/docs/page-actions";
import { ApiReference, SchemaReference } from "@/components/docs/api/api-reference";
import { getAllDocs, getDoc } from "@/lib/docs";
import { site } from "@/site.config";

export const dynamicParams = false;
type Params = { params: Promise<{ section: string; page: string }> };
export function generateStaticParams() { return getAllDocs().map((doc) => { const [section, page] = doc.slug.split("/"); return { section, page }; }); }
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { section, page } = await params;
  const doc = getDoc(`${section}/${page}`);
  if (!doc) return {};
  return { title: doc.title, description: doc.description, alternates: { canonical: `/docs/${doc.slug}`, types: { "text/markdown": `/docs/${doc.slug}/index.md` } }, openGraph: { title: doc.title, description: doc.description, url: `${site.url}/docs/${doc.slug}` } };
}
export default async function DocPage({ params }: Params) {
  const { section, page } = await params;
  const doc = getDoc(`${section}/${page}`);
  if (!doc) notFound();
  const pages = getAllDocs();
  const index = pages.findIndex((entry) => entry.slug === doc.slug);
  const prev = pages[index - 1], next = pages[index + 1];
  return <article>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="eyebrow">{doc.section} / Version {site.version}</p><PageActions markdownPath={`/docs/${doc.slug}/index.md`} /></div>
    <h1 className="mt-6 font-serif text-[2.4rem] leading-[1.1] tracking-display md:text-[3rem]">{doc.title}</h1>
    <p className="mt-4 max-w-2xl text-[1.0625rem] leading-[1.55] text-ink-muted">{doc.description}</p>
    <div className="mt-10 xl:grid xl:grid-cols-[minmax(0,1fr)_190px] xl:gap-10"><div className="blog-prose docs-prose min-w-0">
      {doc.kind === "markdown" ? <Markdown source={doc.content} /> : doc.kind === "api" ? <ApiReference group={doc.group} /> : <SchemaReference schemas={doc.schemas} />}
    </div><aside className="hidden xl:block"><div className="sticky top-28 max-h-[calc(100vh-8rem)] overflow-y-auto pb-6"><Toc items={doc.toc} /></div></aside></div>
    <div className="mt-12 border-t-[0.5px] border-edge pt-5 text-sm text-ink-muted"><a href={`${site.repository}/blob/main/${doc.kind === "markdown" ? doc.source : "openapi.yaml"}`}>View source on GitHub ↗</a></div>
    <nav aria-label="Previous and next pages" className="mt-8 flex justify-between gap-5 text-sm">{prev ? <Link href={`/docs/${prev.slug}`}>← {prev.title}</Link> : <span />}{next && <Link href={`/docs/${next.slug}`}>{next.title} →</Link>}</nav>
  </article>;
}
