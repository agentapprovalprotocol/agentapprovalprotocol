import fs from "node:fs";
import path from "node:path";
import { extractHeadings, type TocItem } from "./content";
import { getApiGroups, getApiSchemas, repositoryRoot, type ApiGroup, type ApiSchema } from "./openapi";
import { site } from "@/site.config";

export const specificationPages = [
  ["overview", "1_overview.md", "Overview", "Approve agent tool calls through a shared, open protocol."],
  ["structure", "0_structure.md", "Structure", "How to read and implement the AAP version 1 specification."],
  ["architecture", "2_architecture.md", "Architecture and modes", "The agent, adapter and provider, and how execution waits for approval."],
  ["identity", "3_identity.md", "Identity and authentication", "Provision instances and manage their credentials and delivery configuration."],
  ["requests", "4_requests.md", "Requests and decisions", "Describe a tool call, record an outcome and enforce its approval."],
  ["http", "5_http.md", "HTTP API", "Operations, authentication, errors, idempotency and retention."],
  ["synchronous", "6_sync.md", "Synchronous mode", "Hold a tool call open and poll for a decision."],
  ["asynchronous", "7_async.md", "Asynchronous mode", "Suspend execution and resume after a signed webhook notification."],
  ["security", "8_security.md", "Security and conformance", "Trust boundaries and the requirements every implementation must meet."],
] as const;

export interface DocMeta { slug: string; section: string; title: string; description: string }
export interface DocsNavSection { title: string; pages: DocMeta[] }
export type DocPage = DocMeta & { toc: TocItem[] } & (
  { kind: "markdown"; content: string; source: string } |
  { kind: "api"; group: ApiGroup } |
  { kind: "schemas"; schemas: ApiSchema[] }
);

export function getDocsNav(): DocsNavSection[] {
  return [
    { title: `Specification · v${site.version}`, pages: specificationPages.map(([slug, , title, description]) => ({ slug: `specification/${slug}`, section: "Specification", title, description })) },
    { title: "API reference", pages: [
      ...getApiGroups().map((group) => ({ slug: `reference/${group.slug}`, section: "API reference", title: group.title, description: group.description })),
      { slug: "reference/schemas", section: "API reference", title: "Schemas", description: "The objects, types and constraints defined by the OpenAPI contract." },
    ] },
  ];
}

export function getAllDocs(): DocMeta[] { return getDocsNav().flatMap((section) => section.pages); }

export function getDoc(slug: string): DocPage | null {
  const meta = getAllDocs().find((entry) => entry.slug === slug);
  if (!meta) return null;
  if (slug.startsWith("specification/")) {
    const entry = specificationPages.find(([name]) => slug === `specification/${name}`)!;
    const source = `docs/specification/${entry[1]}`;
    const content = fs.readFileSync(path.join(repositoryRoot, source), "utf8").replace(/^# .+\r?\n+/, "");
    return { ...meta, kind: "markdown", content, source, toc: extractHeadings(content) };
  }
  if (slug === "reference/schemas") {
    const schemas = getApiSchemas();
    return { ...meta, kind: "schemas", schemas, toc: schemas.map(({ name }) => ({ id: name, title: name, level: 2, code: true })) };
  }
  const group = getApiGroups().find((entry) => slug === `reference/${entry.slug}`)!;
  return { ...meta, kind: "api", group, toc: group.operations.map((op) => ({ id: op.id, title: op.webhook ? op.summary : op.path, level: 2, code: !op.webhook, method: op.method })) };
}

export function resolveDocLink(href: string): string {
  if (/^(https?:|mailto:|#|\/)/.test(href)) return href;
  const [file, anchor] = href.split("#");
  if (file.endsWith("openapi.yaml")) return "/openapi.yaml";
  const entry = specificationPages.find(([, name]) => name === file.replace(/^\.\//, ""));
  if (!entry) throw new Error(`Unmapped documentation link: ${href}`);
  return `/docs/specification/${entry[0]}${anchor ? `#${anchor}` : ""}`;
}

export function markdownFor(doc: DocPage): string {
  const header = `# ${doc.title}\n\n${doc.description}\n\n`;
  if (doc.kind === "markdown") return header + doc.content.replace(/\]\(([^)]+)\)/g, (_, href: string) => `](${resolveDocLink(href)})`);
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
    "See [Schemas](/docs/reference/schemas) and [OpenAPI](/openapi.yaml) for all fields and constraints.",
  ].join("\n\n")).join("\n\n");
}
