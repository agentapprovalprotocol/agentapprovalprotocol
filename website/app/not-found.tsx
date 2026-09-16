import Link from "next/link";
export default function NotFound() { return <article><p className="eyebrow">404</p><h1 className="docs-title">Page not found.</h1><p className="my-6 text-ink-muted">Find the protocol, its HTTP contract and implementation requirements in the documentation.</p><Link href="/docs/specification/overview" className="text-accent">Read the specification →</Link></article>; }
