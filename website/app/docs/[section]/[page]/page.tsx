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
  return <div className="docs-page-grid"><article className="docs-article">
    <div className="docs-page-meta"><p className="eyebrow">{doc.section}</p><PageActions markdownPath={`/docs/${doc.slug}/index.md`} /></div>
    <h1 className="docs-title">{doc.title}</h1>
    <p className="docs-description">{doc.description}</p>
    <div className="docs-article-body blog-prose docs-prose">
      {doc.kind === "markdown" ? <Markdown source={doc.content} /> : doc.kind === "api" ? <ApiReference group={doc.group} /> : <SchemaReference schemas={doc.schemas} />}
    </div>
    <div className="docs-source-link"><a href={`${site.repository}/blob/main/${doc.kind === "markdown" ? doc.source : "openapi.yaml"}`}>View source on GitHub ↗</a></div>
    <nav aria-label="Previous and next pages" className="docs-pagination">{prev ? <Link href={`/docs/${prev.slug}`}>← {prev.title}</Link> : <span />}{next && <Link href={`/docs/${next.slug}`}>{next.title} →</Link>}</nav>
  </article><aside className="docs-contents-rail"><div className="docs-contents"><Toc items={doc.toc} /></div></aside></div>;
}
