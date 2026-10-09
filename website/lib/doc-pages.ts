import apiPageMetadata from "../api-page-metadata.json";

// Each page has a short visible description and a longer one for search results.
export const specificationPages = [
  ["overview", "1_overview.md", "Overview", "Approve agent tool calls through a shared, open protocol.", "Agent Approval Protocol version 1 overview: why agents need approval before acting, the protocol's design goals and the basic flow of an approved tool call."],
  ["structure", "0_structure.md", "Structure", "How to read and implement the AAP version 1 specification.", "How the AAP version 1 specification is organized and how to read it, from the protocol overview to requests, HTTP operations, waiting modes and security."],
  ["architecture", "2_architecture.md", "Architecture and modes", "The agent, adapter and provider, and how execution waits for approval.", "The three parties in AAP, the agent, adapter and provider, and how a tool call waits for approval in synchronous and asynchronous modes."],
  ["identity", "3_identity.md", "Identity and authentication", "Provision instances and manage their credentials and delivery configuration.", "How AAP providers provision agent instances, issue the credentials those instances authenticate with and manage their webhook delivery configuration."],
  ["requests", "4_requests.md", "Requests and decisions", "Describe a tool call, record an outcome and enforce its approval.", "How an AAP approval request describes a proposed tool call, how a provider records its outcome and how the adapter enforces a valid approval."],
  ["http", "5_http.md", "HTTP API", "Operations, authentication, errors, idempotency and retention.", "The AAP HTTP API: operations, authentication, error responses, idempotency keys, retries and data retention for exchanging approval requests as JSON."],
  ["synchronous", "6_sync.md", "Synchronous mode", "Hold a tool call open and poll for a decision.", "In AAP synchronous mode, the adapter holds a tool call open, submits an approval request and polls the provider until the decision is final."],
  ["asynchronous", "7_async.md", "Asynchronous mode", "Suspend execution and resume after a signed webhook notification.", "In AAP asynchronous mode, the harness suspends a tool call, saves its state and resumes after the provider sends a signed webhook with the decision."],
  ["security", "8_security.md", "Security and conformance", "Trust boundaries and the requirements every implementation must meet.", "AAP security requirements: trust boundaries, enforcement at the execution boundary and the conformance rules every adapter and provider must meet."],
] as const;

export type DocsArea = "docs" | "specification";
export interface DocMeta { slug: string; area: DocsArea; section: string; title: string; sidebarTitle?: string; description: string; metaDescription: string }
export interface DocsNavSection { area: DocsArea; title: string; pages: DocMeta[] }
export const documentationPages = [
  { slug: "docs/getting-started/introduction", area: "docs", section: "Get started", title: "What is Agent Approval Protocol (AAP)?", sidebarTitle: "What is AAP?", description: "Give agents a way to ask for approval before their tools take action.", metaDescription: "Agent Approval Protocol (AAP) is an open protocol that lets agents ask an approval provider before their tool calls take action, so risky actions get reviewed.", source: "docs/getting-started/introduction.md" },
  { slug: "docs/concepts/adapter", area: "docs", section: "Core concepts", title: "Adapter", description: "Connect tool calls to an approval provider and enforce its decisions before execution.", metaDescription: "An AAP adapter intercepts an agent's tool calls, asks an approval provider for a decision and enforces it before the tool runs. Learn where adapters fit.", source: "docs/concepts/adapter.md" },
  { slug: "docs/concepts/provider", area: "docs", section: "Core concepts", title: "Provider", description: "Review proposed tool calls and record decisions for adapters to enforce.", metaDescription: "An AAP approval provider decides whether proposed tool calls may run, using automatic policies, human review or both, and records outcomes for adapters.", source: "docs/concepts/provider.md" },
  { slug: "docs/concepts/approval-flow", area: "docs", section: "Core concepts", title: "The approval flow", description: "Understand the adapter, the provider and the two ways an agent can wait.", metaDescription: "See how AAP separates proposing, approving and executing a tool call, and how agents wait for a decision in synchronous or asynchronous mode.", source: "docs/concepts/approval-flow.md" },
  { slug: "docs/adapters/overview", area: "docs", section: "Adapters", title: "Adapters overview", sidebarTitle: "Overview", description: "Choose an adapter and connect it to an approval provider.", metaDescription: "Choose an AAP adapter for Claude Code, Codex, OpenClaw, Pi, Hermes Agent or DeepSeek Harness, and connect it to your approval provider in a few steps.", source: "docs/adapters/overview.md" },
  { slug: "docs/adapters/cli", area: "docs", section: "Adapters", title: "AAP CLI", description: "Install AAP, connect your agents and manage your adapters.", metaDescription: "Install the AAP CLI on macOS or Linux to connect Claude Code, Codex and other agents to an approval provider, then manage credentials and adapters.", source: "docs/adapters/cli.md" },
  { slug: "docs/adapters/claude-code", area: "docs", section: "Adapters", title: "Claude Code", description: "Set up approvals for Claude Code's tool calls.", metaDescription: "Connect Claude Code to an approval provider with the AAP CLI so its tool calls, including MCP tools, are reviewed before they run. Setup, checks and removal.", source: "docs/adapters/claude-code.md" },
  { slug: "docs/adapters/codex", area: "docs", section: "Adapters", title: "Codex", description: "Set up approvals for Codex's tool calls.", metaDescription: "Connect Codex to an approval provider with the AAP CLI so its tool calls are reviewed before they run. Covers setup, checking it works and uninstalling.", source: "docs/adapters/codex.md" },
  { slug: "docs/adapters/openclaw", area: "docs", section: "Adapters", title: "OpenClaw", description: "Set up approvals for OpenClaw's tool calls.", metaDescription: "Connect OpenClaw to an approval provider with the AAP CLI so its tool calls are reviewed before they run. Covers setup, checking it works and uninstalling.", source: "docs/adapters/openclaw.md" },
  { slug: "docs/adapters/pi", area: "docs", section: "Adapters", title: "Pi", description: "Set up approvals for Pi's tool calls.", metaDescription: "Connect Pi to an approval provider with the AAP CLI so its tool calls are reviewed before they run. Covers setup, checking it works, limits and uninstalling.", source: "docs/adapters/pi.md" },
  { slug: "docs/adapters/hermes", area: "docs", section: "Adapters", title: "Hermes Agent", description: "Set up approvals for Hermes Agent's tool calls.", metaDescription: "Connect Hermes Agent to an approval provider with the AAP CLI so its tool calls are reviewed before they run. Covers setup, checking it works and uninstalling.", source: "docs/adapters/hermes.md" },
  { slug: "docs/adapters/deepseek", area: "docs", section: "Adapters", title: "DeepSeek Harness", description: "Set up approvals for DeepSeek Harness's tool calls.", metaDescription: "Connect DeepSeek Harness to an approval provider with the AAP CLI so its tool calls are reviewed before they run. Covers setup, checks and uninstalling.", source: "docs/adapters/deepseek.md" },
  { slug: "docs/providers/overview", area: "docs", section: "Providers", title: "Providers overview", sidebarTitle: "Overview", description: "Choose an approval provider and connect your adapters.", metaDescription: "Choose an AAP approval provider or build your own, then connect your adapters so proposed tool calls are approved by policy, by a person or by both.", source: "docs/providers/overview.md" },
] satisfies (DocMeta & { source: string })[];

export const markdownPages = [
  ...documentationPages,
  ...specificationPages.map(([slug, file, title, description, metaDescription]) => ({ slug: `specification/${slug}`, area: "specification" as const, section: "Protocol", title, description, metaDescription, source: `docs/specification/${file}` })),
  { slug: "specification/reference/overview", area: "specification" as const, section: "API reference", title: "Overview", description: "Connect to an approval provider, submit a tool call and receive a decision.", metaDescription: "The AAP API reference: connect an adapter to an approval provider over HTTP and JSON, submit proposed tool calls and retrieve approval decisions.", source: "docs/specification/api_overview.md" },
];

// Generated reference pages already require an entry in the page metadata file.
const documentPaths = new Set([
  ...markdownPages.map((page) => `/${page.slug}`),
  ...Object.keys(apiPageMetadata).map((slug) => `/${slug}`),
]);

export function isDocumentPath(pathname: string): boolean {
  return documentPaths.has(pathname);
}
