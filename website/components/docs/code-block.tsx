import * as React from "react";
import { highlight } from "@/lib/shiki";
import { CodeFrame } from "./code-frame";

export { CodeFrame } from "./code-frame";

/* Docs code block: a hairline frame on fill with a header row (filename when
 * the fence carries title="...", else the language as a kicker) and a copy
 * button, wrapped around the <pre> Shiki emits. Element rules live in
 * globals.css under "Docs components". */

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
