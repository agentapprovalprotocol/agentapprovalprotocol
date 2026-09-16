import type { RehypeShikiOptions } from "@shikijs/rehype";
import { codeToHtml, type ShikiTransformer } from "shiki";
import { aapDark, aapLight } from "./shiki-theme";

/* Shared Shiki setup for docs fences. components/docs/code-block.tsx draws
 * the frame (header row with filename or language, copy button) around the
 * <pre> Shiki emits, so the transformer drops Shiki's inline background and
 * forwards the language as a data attribute for the header to read. Both
 * themes are emitted at once (defaultColor: false): every token carries
 * --shiki-light and --shiki-dark, and globals.css picks one by data-theme. */

const themes = { light: aapLight, dark: aapDark };

const frame: ShikiTransformer = {
  name: "aap:frame",
  pre(node) {
    delete node.properties.style;
    node.properties["data-lang"] = this.options.lang;
  },
};

/* ```ts title="agent.ts" becomes data-title="agent.ts" on the <pre>. */
export function parseMetaString(meta: string) {
  const title = meta.match(/title="([^"]*)"/)?.[1];
  return title ? { "data-title": title } : null;
}

export const shikiOptions: RehypeShikiOptions = {
  themes,
  defaultColor: false,
  transformers: [frame],
  parseMetaString,
};

/* For callers outside MDX (the styleguide): the highlighted <pre> as HTML. */
export function highlight(code: string, lang: string, title?: string) {
  return codeToHtml(code, {
    lang,
    themes,
    defaultColor: false,
    transformers: [frame],
    meta: title ? { "data-title": title } : undefined,
  });
}
