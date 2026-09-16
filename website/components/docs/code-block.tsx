import * as React from "react";
import { highlight } from "@/lib/shiki";
import { CopyButton } from "./copy-button";

/* Docs code block: a hairline frame on fill with a header row (filename when
 * the fence carries title="...", else the language as a kicker) and a copy
 * button, wrapped around the <pre> Shiki emits. Element rules live in
 * globals.css under "Docs components". */

export function CodeFrame({
  lang,
  title,
  children,
}: {
  lang?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="docs-code">
      <div className="docs-code-header">
        {title ? (
          <span className="font-mono text-[0.75rem] text-ink-muted">{title}</span>
        ) : (
          <span className="font-sans text-[0.6875rem] uppercase tracking-[0.08em] text-ink-faint">
            {lang ?? "text"}
          </span>
        )}
        <CopyButton />
      </div>
      {children}
    </figure>
  );
}

type CodeBlockProps = React.ComponentPropsWithoutRef<"pre"> & {
  "data-lang"?: string;
  "data-title"?: string;
};

/* The MDX `pre` override: receives the Shiki <pre> props. */
export function CodeBlock({
  "data-lang": lang,
  "data-title": title,
  ...pre
}: CodeBlockProps) {
  return (
    <CodeFrame lang={lang} title={title}>
      <pre {...pre} data-lang={lang} />
    </CodeFrame>
  );
}

/* For hand-written pages such as the styleguide. */
export async function HighlightedCode({
  code,
  lang,
  title,
}: {
  code: string;
  lang: string;
  title?: string;
}) {
  const html = await highlight(code, lang, title);
  return (
    <CodeFrame lang={lang} title={title}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </CodeFrame>
  );
}
