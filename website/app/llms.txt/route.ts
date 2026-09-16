import { getDocsNav } from "@/lib/docs";
import { site } from "@/site.config";
export const dynamic = "force-static";
export function GET() {
  const content = [`# ${site.name}`, "", `> ${site.description}`, "", ...getDocsNav().flatMap((section) => [`## ${section.title}`, "", ...section.pages.map((page) => `- [${page.title}](${site.url}/docs/${page.slug}/index.md): ${page.description}`), ""]), `- [OpenAPI schema](${site.url}/openapi.yaml)`].join("\n");
  return new Response(content, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
