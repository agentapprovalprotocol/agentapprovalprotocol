import fs from "node:fs";
import path from "node:path";
import apiPageMetadata from "../api-page-metadata.json";
import { extractHeadings, type TocItem } from "./content";
import { getApiGroups, getApiSchemas, repositoryRoot, specPath, type ApiGroup, type ApiSchema } from "./openapi";
import { parseMarkdownPage, validateLastModified } from "./page-metadata";
import { documentationPages, markdownPages, type DocMeta, type DocsArea, type DocsNavSection } from "./doc-pages";

export { specificationPages, type DocMeta, type DocsArea, type DocsNavSection } from "./doc-pages";

export type DocPage = DocMeta & { toc: TocItem[] } & (
  { kind: "markdown"; content: string; source: string } |
  { kind: "api"; group: ApiGroup } |
  { kind: "schemas"; schemas: ApiSchema[] } |
  { kind: "openapi"; content: string }
);

export function getDocsNav(area?: DocsArea): DocsNavSection[] {
  const sections: DocsNavSection[] = [
    ...["Get started", "Core concepts", "Adapters", "Providers"].map((title) => ({ area: "docs" as const, title, pages: documentationPages.filter((page) => page.section === title) })),
    { area: "specification", title: "Protocol", pages: markdownPages.filter((page) => page.section === "Protocol") },
    { area: "specification", title: "API reference", pages: [
      markdownPages.find((page) => page.slug === "specification/reference/overview")!,
      ...getApiGroups().map((group) => ({ slug: `specification/reference/${group.slug}`, area: "specification" as const, section: "API reference", title: group.title, description: group.description, metaDescription: generatedMetaDescription(`specification/reference/${group.slug}`) })),
      { slug: "specification/reference/schemas", area: "specification", section: "API reference", title: "Schemas", description: "The objects, types and constraints defined by the OpenAPI contract.", metaDescription: generatedMetaDescription("specification/reference/schemas") },
      { slug: "specification/reference/openapi", area: "specification", section: "API reference", title: "OpenAPI schema", description: "Read or download the complete OpenAPI contract for AAP.", metaDescription: generatedMetaDescription("specification/reference/openapi") },
    ] },
  ];
  return area ? sections.filter((section) => section.area === area) : sections;
}

function generatedMetaDescription(slug: string): string {
  const metadata: Record<string, { metaDescription?: string }> = apiPageMetadata;
  const value = metadata[slug]?.metaDescription;
  if (!value) throw new Error(`metaDescription in website/api-page-metadata.json (${slug}) is required`);
  return value;
}

export function getAllDocs(area?: DocsArea): DocMeta[] { return getDocsNav(area).flatMap((section) => section.pages); }

function readMarkdownPage(source: string) {
  return parseMarkdownPage(fs.readFileSync(path.join(repositoryRoot, source), "utf8"), source);
}

export function getDocLastModified(slug: string): string {
  const source = markdownPages.find((page) => page.slug === slug)?.source;
  if (source) return readMarkdownPage(source).lastModified;
  const metadata: Record<string, { lastModified: string }> = apiPageMetadata;
  return validateLastModified(metadata[slug]?.lastModified, `website/api-page-metadata.json (${slug})`);
}

export function getAdjacentDocs(doc: DocMeta) {
  const pages = getAllDocs(doc.area);
  const index = pages.findIndex((page) => page.slug === doc.slug);
  return { prev: pages[index - 1], next: pages[index + 1] };
}

export function getDoc(slug: string): DocPage | null {
  const meta = getAllDocs().find((entry) => entry.slug === slug);
  if (!meta) return null;
  if (slug === "specification/reference/openapi") {
    return { ...meta, kind: "openapi", content: fs.readFileSync(specPath, "utf8"), toc: [] };
  }
  const source = markdownPages.find((page) => page.slug === slug)?.source;
  if (source) {
    let content = readMarkdownPage(source).content.replace(/^(?:\r?\n)*# .+\r?\n+/, "");
    if (slug === "specification/reference/overview") {
      const pages = getAllDocs().filter((page) => page.section === meta.section && page.slug !== slug);
      content += `\n## Explore the reference\n\n| Section | Description |\n| --- | --- |\n${pages.map((page) => `| [${page.title}](/${page.slug}) | ${page.description} |`).join("\n")}\n`;
    }
    return { ...meta, kind: "markdown", content, source, toc: extractHeadings(content) };
  }
  if (slug === "specification/reference/schemas") {
    const schemas = getApiSchemas();
    return { ...meta, kind: "schemas", schemas, toc: schemas.map(({ name }) => ({ id: name, title: name, level: 2, code: true })) };
  }
  const group = getApiGroups().find((entry) => slug === `specification/reference/${entry.slug}`)!;
  return { ...meta, kind: "api", group, toc: group.operations.map((op) => ({ id: op.id, title: op.webhook ? op.summary : op.path, level: 2, code: !op.webhook, method: op.method })) };
}

export function resolveDocLink(href: string, source: string): string {
  if (/^(https?:|mailto:|#|\/)/.test(href)) return href;
  const [file, anchor] = href.split("#");
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), file));
  if (target === "openapi.yaml") return `/specification/reference/openapi${anchor ? `#${anchor}` : ""}`;
  const entry = markdownPages.find((page) => page.source === target);
  if (!entry) throw new Error(`Unmapped documentation link in ${source}: ${href}`);
  return `/${entry.slug}${anchor ? `#${anchor}` : ""}`;
}

export function markdownFor(doc: DocPage): string {
  const header = `# ${doc.title}\n\n${doc.description}\n\n`;
  if (doc.kind === "openapi") return `${header}[Download YAML](/openapi.yaml)\n\n\`\`\`yaml\n${doc.content}\n\`\`\`\n`;
  if (doc.kind === "markdown") return header + doc.content.replace(/\]\(([^)]+)\)/g, (_, href: string) => `](${resolveDocLink(href, doc.source)})`);
  if (doc.kind === "schemas") return header + doc.schemas.map(({ name, schema }) => `## ${name}\n\n${schema.description ?? ""}\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``).join("\n\n");
  return header + doc.group.operations.map((op) => [
    `## ${op.summary}`, `\`${op.method} ${op.path}\``, op.description,
    `Authentication: ${op.auth.map((alternative) => alternative.map((scheme) => scheme.name).join(" and ")).join(" or ") || "None"}`,
    ...op.parameters.map((parameter) => `- \`${parameter.name}\`${parameter.required ? " (required)" : ""}: ${parameter.description ?? ""}`),
    ...op.requestBody?.examples.map((example) => `### Request: ${example.name}\n\n\`\`\`json\n${JSON.stringify(example.value, null, 2)}\n\`\`\``) ?? [],
    ...op.responses.flatMap((response) => [
      `### Response ${response.status}`, response.description,
      ...response.headers.map((header) => `- \`${header.name}\`${header.required ? " (required)" : ""}: ${header.description ?? ""}`),
      ...response.examples.map((example) => `\`\`\`json\n${JSON.stringify(example.value, null, 2)}\n\`\`\``),
    ]),
    "See [Schemas](/specification/reference/schemas) and [OpenAPI](/specification/reference/openapi) for all fields and constraints.",
  ].join("\n\n")).join("\n\n");
}
