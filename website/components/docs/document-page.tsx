import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Toc } from "@/components/blog/toc";
import { Markdown } from "@/components/docs/markdown";
import { PageActions } from "@/components/docs/page-actions";
import { HighlightedCode } from "@/components/docs/code-block";
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
    <div className="docs-page-meta"><p className="eyebrow">{doc.section}</p>{doc.kind === "openapi" ? <a href="/openapi.yaml" download="openapi.yaml" className="inline-flex items-center gap-1.5 rounded-lg border-[0.5px] border-edge-strong bg-surface px-2.5 py-1.5 text-[0.8125rem] leading-none text-ink-soft transition-colors hover:bg-fill hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3.5"><path d="M8 2v8m-3-3 3 3 3-3M3 11v2h10v-2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
      Download YAML
    </a> : <PageActions markdownPath={`/${doc.slug}/index.md`} />}</div>
    <h1 className="docs-title">{doc.title}</h1>
    <p className="docs-description">{doc.description}</p>
    <div className="docs-article-body blog-prose docs-prose">
      {doc.kind === "markdown" ? <Markdown source={doc.content} sourcePath={doc.source} /> : doc.kind === "api" ? <ApiReference group={doc.group} /> : doc.kind === "schemas" ? <SchemaReference schemas={doc.schemas} /> : <>
        <p>For descriptions of endpoints and data types, browse the <Link href="/specification/reference/overview">API reference</Link>.</p>
        <HighlightedCode code={doc.content} lang="yaml" title="openapi.yaml" />
      </>}
    </div>
    <div className="docs-source-link"><a href={`${site.repository}/blob/main/${doc.kind === "markdown" ? doc.source : "openapi.yaml"}`}>View source on GitHub ↗</a></div>
    <nav aria-label="Previous and next pages" className="docs-pagination">{prev ? <Link href={`/${prev.slug}`}>← {prev.title}</Link> : <span />}{next && <Link href={`/${next.slug}`}>{next.title} →</Link>}</nav>
  </article><aside className="docs-contents-rail"><div className="docs-contents"><Toc items={doc.toc} /></div></aside></div>;
}
