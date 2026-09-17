import fs from "node:fs";
import path from "node:path";
import apiPageMetadata from "../api-page-metadata.json";
import { extractHeadings, type TocItem } from "./content";
import { getApiGroups, getApiSchemas, repositoryRoot, specPath, type ApiGroup, type ApiSchema } from "./openapi";
import { parseMarkdownPage, validateLastModified } from "./page-metadata";

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

export type DocsArea = "docs" | "specification";
export interface DocMeta { slug: string; area: DocsArea; section: string; title: string; sidebarTitle?: string; description: string }
export interface DocsNavSection { area: DocsArea; title: string; pages: DocMeta[] }
export type DocPage = DocMeta & { toc: TocItem[] } & (
  { kind: "markdown"; content: string; source: string } |
  { kind: "api"; group: ApiGroup } |
  { kind: "schemas"; schemas: ApiSchema[] } |
  { kind: "openapi"; content: string }
);

const documentationPages = [
  { slug: "docs/getting-started/introduction", area: "docs", section: "Get started", title: "What is Agent Approval Protocol (AAP)?", sidebarTitle: "What is AAP?", description: "Give agents a way to ask for approval before their tools take action.", source: "docs/getting-started/introduction.md" },
  { slug: "docs/concepts/adapter", area: "docs", section: "Core concepts", title: "Adapter", description: "Connect tool calls to an approval provider and enforce its decisions before execution.", source: "docs/concepts/adapter.md" },
  { slug: "docs/concepts/provider", area: "docs", section: "Core concepts", title: "Provider", description: "Review proposed tool calls and record decisions for adapters to enforce.", source: "docs/concepts/provider.md" },
  { slug: "docs/concepts/approval-flow", area: "docs", section: "Core concepts", title: "The approval flow", description: "Understand the adapter, the provider and the two ways an agent can wait.", source: "docs/concepts/approval-flow.md" },
  { slug: "docs/adapters/overview", area: "docs", section: "Adapters", title: "Adapters overview", sidebarTitle: "Overview", description: "Choose an adapter and connect it to an approval provider.", source: "docs/adapters/overview.md" },
  { slug: "docs/adapters/claude-code", area: "docs", section: "Adapters", title: "Claude Code", description: "Request approval through Claude Code's tool hooks.", source: "docs/adapters/claude-code.md" },
  { slug: "docs/adapters/codex", area: "docs", section: "Adapters", title: "Codex", description: "Connect Codex command hooks to an approval provider.", source: "docs/adapters/codex.md" },
  { slug: "docs/adapters/openclaw", area: "docs", section: "Adapters", title: "OpenClaw", description: "Review OpenClaw tool calls through a native Gateway plugin.", source: "docs/adapters/openclaw.md" },
  { slug: "docs/adapters/pi", area: "docs", section: "Adapters", title: "Pi", description: "Hold Pi tool calls for approval through a native extension.", source: "docs/adapters/pi.md" },
  { slug: "docs/adapters/hermes", area: "docs", section: "Adapters", title: "Hermes Agent", description: "Connect Hermes shell hooks to an approval provider.", source: "docs/adapters/hermes.md" },
  { slug: "docs/adapters/deepseek", area: "docs", section: "Adapters", title: "DeepSeek Harness", description: "Request approval from DeepSeek Harness through its hooks bridge.", source: "docs/adapters/deepseek.md" },
  { slug: "docs/adapters/mcp-wrapper", area: "docs", section: "Adapters", title: "MCP wrapper", description: "Add approval to an MCP server through a local proxy.", source: "docs/adapters/mcp-wrapper.md" },
  { slug: "docs/adapters/mcp-gateway", area: "docs", section: "Adapters", title: "MCP gateway", description: "Centralize MCP access and keep downstream credentials at the gateway.", source: "docs/adapters/mcp-gateway.md" },
] satisfies (DocMeta & { source: string })[];

const markdownPages = [
  ...documentationPages,
  ...specificationPages.map(([slug, file, title, description]) => ({ slug: `specification/${slug}`, area: "specification" as const, section: "Protocol", title, description, source: `docs/specification/${file}` })),
  { slug: "specification/reference/overview", area: "specification" as const, section: "API reference", title: "Overview", description: "Connect to an approval provider, submit a tool call and receive a decision.", source: "docs/specification/api_overview.md" },
];

export function getDocsNav(area?: DocsArea): DocsNavSection[] {
  const sections: DocsNavSection[] = [
    ...["Get started", "Core concepts", "Adapters"].map((title) => ({ area: "docs" as const, title, pages: documentationPages.filter((page) => page.section === title) })),
    { area: "specification", title: "Protocol", pages: markdownPages.filter((page) => page.section === "Protocol") },
    { area: "specification", title: "API reference", pages: [
      markdownPages.find((page) => page.slug === "specification/reference/overview")!,
      ...getApiGroups().map((group) => ({ slug: `specification/reference/${group.slug}`, area: "specification" as const, section: "API reference", title: group.title, description: group.description })),
      { slug: "specification/reference/schemas", area: "specification", section: "API reference", title: "Schemas", description: "The objects, types and constraints defined by the OpenAPI contract." },
      { slug: "specification/reference/openapi", area: "specification", section: "API reference", title: "OpenAPI schema", description: "Read or download the complete OpenAPI contract for AAP." },
    ] },
  ];
  return area ? sections.filter((section) => section.area === area) : sections;
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
