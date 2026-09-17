import { site } from "@/site.config";

export function externalLinkProps(href: string) {
  const external = /^(https?:)?\/\//i.test(href)
    && new URL(href, site.url).origin !== new URL(site.url).origin;
  return external ? { target: "_blank", rel: "noopener noreferrer" } : {};
}
