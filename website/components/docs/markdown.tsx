import Link from "next/link";
import { MDXRemote } from "next-mdx-remote/rsc";
import type { MDXComponents } from "mdx/types";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeShiki from "@shikijs/rehype";
import { resolveDocLink } from "@/lib/docs";
import rehypeMermaid from "@/lib/rehype-mermaid";
import { shikiOptions } from "@/lib/shiki";
import { CodeBlock } from "./code-block";
import { Mermaid } from "./mermaid";

const components: MDXComponents = {
  pre: CodeBlock,
  "mermaid-diagram": Mermaid,
  a: ({ href = "", children, ...rest }) => {
    const url = resolveDocLink(href);
    return url.startsWith("/") || url.startsWith("#") ?
      <Link href={url} {...rest}>{children}</Link> : <a href={url} {...rest}>{children}</a>;
  },
  table: ({ children, ...props }) => <div className="blog-table-wrap"><table {...props}>{children}</table></div>,
};

export function Markdown({ source }: { source: string }) {
  return <MDXRemote source={source} components={components} options={{ mdxOptions: {
    remarkPlugins: [remarkGfm], rehypePlugins: [rehypeMermaid, rehypeSlug, [rehypeShiki, shikiOptions]],
  } }} />;
}
