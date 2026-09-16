import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Toc } from "@/components/blog/toc";
import { Markdown } from "@/components/docs/markdown";
import { PageActions } from "@/components/docs/page-actions";
import { ApiReference, SchemaReference } from "@/components/docs/api/api-reference";
import { getAdjacentDocs, getDoc } from "@/lib/docs";
import { site } from "@/site.config";

export function documentMetadata(slug: string): Metadata {
  const doc = getDoc(slug);
  if (!doc) return {};
  return { title: doc.title, description: doc.description, alternates: { canonical: `/${doc.slug}`, types: { "text/markdown": `/${doc.slug}/index.md` } }, openGraph: { title: doc.title, description: doc.description, url: `${site.url}/${doc.slug}` } };
}

export function DocumentPage({ slug }: { slug: string }) {
  const doc = getDoc(slug);
  if (!doc) notFound();
  const { prev, next } = getAdjacentDocs(doc);
  return <div className="docs-page-grid"><article className="docs-article">
    <div className="docs-page-meta"><p className="eyebrow">{doc.section}</p><PageActions markdownPath={`/${doc.slug}/index.md`} /></div>
    <h1 className="docs-title">{doc.title}</h1>
    <p className="docs-description">{doc.description}</p>
    <div className="docs-article-body blog-prose docs-prose">
      {doc.kind === "markdown" ? <Markdown source={doc.content} sourcePath={doc.source} /> : doc.kind === "api" ? <ApiReference group={doc.group} /> : <SchemaReference schemas={doc.schemas} />}
    </div>
    <div className="docs-source-link"><a href={`${site.repository}/blob/main/${doc.kind === "markdown" ? doc.source : "openapi.yaml"}`}>View source on GitHub ↗</a></div>
    <nav aria-label="Previous and next pages" className="docs-pagination">{prev ? <Link href={`/${prev.slug}`}>← {prev.title}</Link> : <span />}{next && <Link href={`/${next.slug}`}>{next.title} →</Link>}</nav>
  </article><aside className="docs-contents-rail"><div className="docs-contents"><Toc items={doc.toc} /></div></aside></div>;
}
