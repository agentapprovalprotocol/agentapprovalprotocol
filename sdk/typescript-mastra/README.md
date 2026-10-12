# Agent Approval Protocol for Mastra

Put a [Mastra](https://mastra.ai) agent's tool calls behind an [AAP](https://agentapprovalprotocol.io) approval provider. Each call waits for the provider's decision, runs only if approved, and runs at most once.

```sh
npm install @agentapprovalprotocol/mastra @agentapprovalprotocol/sdk
```

It needs `@mastra/core` 1.76 or later and Node.js 22.13 or later.

## Gate an agent

```ts
import { Client, Gate } from "@agentapprovalprotocol/sdk";
import { Approvals } from "@agentapprovalprotocol/mastra";
import { Agent } from "@mastra/core/agent";

const approvals = new Approvals(new Gate(new Client("https://approvals.example.com/api/aap", token)));

const agent = new Agent(approvals.config({ id: "support", name: "Support", instructions, model, tools }));
```

Every tool call the agent makes goes to the provider: its own tools, MCP tools, workflows, memory and workspace tools, and calls to sub-agents. A denied call returns the reason to the model as a tool error.

Build every sub-agent with `approvals.config` too, then check that nothing is left ungated:

```ts
await approvals.check(agent);
```

`check` throws if the agent or a sub-agent is missing the approval hooks, or has a tool that runs outside Mastra.

## Pause instead of waiting

With `new Gate(client, { mode: "async" })`, a call with no decision yet suspends the run, and the process can exit. The run finishes with `finishReason` set to `"suspended"`. Give the Mastra instance storage so runs can resume after a restart.

Mount a `Receiver` where the provider can reach it, with a resumer for the agents you start runs on:

```ts
import { Receiver } from "@agentapprovalprotocol/sdk";
import { resumer } from "@agentapprovalprotocol/mastra";

const receiver = new Receiver({ secret, client, resumers: { mastra: resumer(agent, { onResult }) } });
```

When the decision arrives, the run continues in that process. `onResult` receives its output. Resuming a run any other way, such as `approveToolCall` or `resumeStream`, cannot approve a call: the provider is asked again.

## Limitations

- Do not pass `hooks` to a single run. Mastra uses them in place of the agent's approval hooks.
- Client tools and provider-run tools (such as a model's built-in web search) never reach Mastra's hooks, so they are not gated. `check` reports them.
- Leave Mastra's own `requireToolApproval` off on sub-agents. A streamed parent refuses the sub-agent call when its approval resumes.
- A paused call in a sub-agent resumes through its parent. Pass the parent to `resumer`.
- The provider approves the arguments the model sent, before the tool's input schema applies defaults or transforms.
