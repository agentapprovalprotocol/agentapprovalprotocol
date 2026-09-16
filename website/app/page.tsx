import Link from "next/link";
import { site } from "@/site.config";
import { getDocsNav } from "@/lib/docs";

export default function Home() {
  const sections = getDocsNav();
  return <main id="main-content" className="home-main">
    <section className="home-hero"><p className="eyebrow">Agent Approval Protocol · Version {site.version}</p>
      <h1>A shared language<br />for agent approvals.</h1>
      <p className="home-lead">Agents make tool calls. AAP lets an adapter ask whether a call may run, wait for a decision and enforce the answer.</p>
      <div className="hero-actions"><Link className="primary-link" href="/docs/specification/overview">Read the specification <span aria-hidden>↗</span></Link><Link className="secondary-link" href="/docs/reference/requests">Explore the API <span aria-hidden>→</span></Link></div>
    </section>
    <div className="protocol-strip" aria-label="Approval flow"><span>Agent calls a tool</span><span aria-hidden>→</span><span>Adapter requests approval</span><span aria-hidden>→</span><span>Provider decides</span><span aria-hidden>→</span><span>Adapter enforces</span></div>
    <section className="home-docs"><div className="home-section-heading"><p className="eyebrow">Start building</p><h2>One protocol.<br />Two ways to wait.</h2><p>Poll whilst a tool call stays open, or suspend execution and resume when a decision is ready. Both modes use the same request and decision model.</p></div>
      <div className="home-cards"><Link href="/docs/specification/synchronous"><span className="eyebrow">01 / Synchronous</span><h3>Keep the call open.</h3><p>Submit a request and poll the provider until it reaches a decision.</p><span className="card-link">Synchronous mode ↗</span></Link><Link href="/docs/specification/asynchronous"><span className="eyebrow">02 / Asynchronous</span><h3>Resume when ready.</h3><p>Save the pending call, suspend execution and receive a signed webhook.</p><span className="card-link">Asynchronous mode ↗</span></Link></div>
    </section>
    <section className="home-index" aria-label="Documentation index">{sections.map((section) => <div key={section.title}><h2>{section.title}</h2>{section.pages.map((page) => <Link key={page.slug} href={`/docs/${page.slug}`}><span>{page.title}</span><span aria-hidden>↗</span></Link>)}</div>)}</section>
  </main>;
}
