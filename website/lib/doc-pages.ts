import apiPageMetadata from "../api-page-metadata.json";

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
export const documentationPages = [
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
  { slug: "docs/providers/overview", area: "docs", section: "Providers", title: "Providers overview", sidebarTitle: "Overview", description: "Choose an approval provider and connect your adapters.", source: "docs/providers/overview.md" },
] satisfies (DocMeta & { source: string })[];

export const markdownPages = [
  ...documentationPages,
  ...specificationPages.map(([slug, file, title, description]) => ({ slug: `specification/${slug}`, area: "specification" as const, section: "Protocol", title, description, source: `docs/specification/${file}` })),
  { slug: "specification/reference/overview", area: "specification" as const, section: "API reference", title: "Overview", description: "Connect to an approval provider, submit a tool call and receive a decision.", source: "docs/specification/api_overview.md" },
];

// Generated reference pages already require an entry in the page metadata file.
const documentPaths = new Set([
  ...markdownPages.map((page) => `/${page.slug}`),
  ...Object.keys(apiPageMetadata).map((slug) => `/${slug}`),
]);

export function isDocumentPath(pathname: string): boolean {
  return documentPaths.has(pathname);
}
