---
lastModified: 2026-10-12
---

# Mastra

Send every tool call of a Mastra agent to your approval provider before it runs: its own tools, MCP tools, workflows, memory and workspace tools, and calls to sub-agents.

## Install

```sh
npm install @agentapprovalprotocol/mastra @agentapprovalprotocol/sdk
```

It needs `@mastra/core` 1.76 or later and Node.js 22.13 or later.

## Set up

Build the agent's config with `approvals.config`, then check coverage:

```ts
import { Client, Gate } from "@agentapprovalprotocol/sdk";
import { Approvals } from "@agentapprovalprotocol/mastra";
import { Agent } from "@mastra/core/agent";

const approvals = new Approvals(new Gate(new Client("https://approvals.example.com/api/aap", process.env.AAP_INSTANCE_TOKEN!)));

const agent = new Agent(approvals.config({ id: "support", name: "Support", instructions, model, tools }));
await approvals.check(agent);
```

Each call waits for the decision. A denied call returns the reason to the model as a tool error.

`check` throws if the agent or a sub-agent is missing the approval hooks, or has a tool that runs outside Mastra.

## Pause instead of waiting

Use a gate in pause mode:

```ts
const approvals = new Approvals(new Gate(client, { mode: "async" }));
```

When a call waits for its decision, the run suspends and finishes with `finishReason` set to `"suspended"`. Give the Mastra instance storage so runs can resume after a restart.

Give the [receiver](overview.md#resume-paused-runs) a Mastra resumer for the agents you start runs on:

```ts
import { resumer } from "@agentapprovalprotocol/mastra";

const resumers = { mastra: resumer(agent, { onResult }) };
```

When the decision arrives, the run continues in the receiver's process. `onResult` receives its output. Pass an array to `resumer` to cover several agents.

Resuming a run any other way, such as `approveToolCall` or `resumeStream`, cannot approve a call. The provider is asked again.

## Sub-agents

Build every sub-agent with `approvals.config` too. `check` reports any that are missing it. A paused call in a sub-agent resumes through its parent, so pass the parent to `resumer`.

## Limitations

- **Hooks on a single run:** Do not pass `hooks` to a single run. Mastra uses them in place of the agent's approval hooks.
- **Client tools and provider-run tools:** Tools such as a model's built-in web search never reach Mastra's hooks, so they are not sent for approval. `check` reports them. Remove them, or use a tool with its own `execute`.
- **Mastra's own approval on sub-agents:** Leave `requireToolApproval` off on sub-agents. A streamed parent refuses the sub-agent call when its approval resumes.
- **Input schema changes:** The provider approves the arguments the model sent, before the tool's input schema applies defaults or transforms.

## Test without a provider

Pass a gate built on [`FakeProvider`](overview.md#test-without-a-provider):

```ts
import { Gate } from "@agentapprovalprotocol/sdk";
import { FakeProvider } from "@agentapprovalprotocol/sdk/testing";

const provider = new FakeProvider();
const approvals = new Approvals(new Gate(provider.client()));
```
