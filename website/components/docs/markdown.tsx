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
import { Heading } from "./heading";

const components: MDXComponents = {
  h1: (props) => <Heading as="h1" {...props} />,
  h2: (props) => <Heading as="h2" {...props} />,
  h3: (props) => <Heading as="h3" {...props} />,
  h4: (props) => <Heading as="h4" {...props} />,
  h5: (props) => <Heading as="h5" {...props} />,
  h6: (props) => <Heading as="h6" {...props} />,
  pre: CodeBlock,
  "mermaid-diagram": Mermaid,
  table: ({ children, ...props }) => <div className="blog-table-wrap"><table {...props}>{children}</table></div>,
};

export function Markdown({ source, sourcePath }: { source: string; sourcePath: string }) {
  const pageComponents: MDXComponents = {
    ...components,
    a: ({ href = "", children, ...rest }) => {
      const url = resolveDocLink(href, sourcePath);
      return url.startsWith("/") || url.startsWith("#") ?
        <Link href={url} {...rest}>{children}</Link> : <a href={url} {...rest}>{children}</a>;
    },
  };
  return <MDXRemote source={source} components={pageComponents} options={{ mdxOptions: {
    remarkPlugins: [remarkGfm], rehypePlugins: [rehypeMermaid, rehypeSlug, [rehypeShiki, shikiOptions]],
  } }} />;
}
