import { Fragment } from "react";
import { externalLinkProps } from "@/lib/links";
import { site } from "@/site.config";

/* Supports code spans and inline Markdown links in OpenAPI descriptions.
 * Other markup stays plain text. Canonical site links stay on the current host
 * so local previews and deployed documentation navigate the same way. */
export function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]*`|\[[^\]]+\]\([^\s)]+\))/);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
          return <code key={i}>{part.slice(1, -1)}</code>;
        }
        const link = part.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
        if (link) {
          const href = link[2].startsWith(`${site.url}/`) ? link[2].slice(site.url.length) : link[2];
          const label = <Inline text={link[1]} />;
          return /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(href)
            ? <a key={i} href={href} {...externalLinkProps(href)}>{label}</a>
            : <Fragment key={i}>{label}</Fragment>;
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
