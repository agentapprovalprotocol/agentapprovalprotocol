---
lastModified: 2026-10-12
---

# Vercel AI SDK

Send every tool call of a Vercel AI SDK agent to your approval provider before it runs, including MCP tools.

## Install

```sh
npm install @agentapprovalprotocol/ai-sdk @agentapprovalprotocol/sdk ai
```

It needs AI SDK 7 and Node.js 22 or later.

## Set up

Spread `approvals` into the agent's settings:

```ts
import { Client, Gate } from "@agentapprovalprotocol/sdk";
import { approvals } from "@agentapprovalprotocol/ai-sdk";
import { ToolLoopAgent } from "ai";

const gate = new Gate(new Client("https://approvals.example.com/api/aap", process.env.AAP_INSTANCE_TOKEN!));

const agent = new ToolLoopAgent({ model, tools, ...approvals({ gate }) });
```

It works the same with `generateText` and `streamText`. Each call waits for the decision. A denied call returns the reason to the model.

`approvals` sets `toolApproval` and `onToolExecutionEnd`. If you have your own `onToolExecutionEnd`, call the one from `approvals` inside it, so outcomes are still reported.

## Pause instead of waiting

Use a gate in pause mode, give every run a thread ID in `runtimeContext.threadId`, and store each thread's messages on your server:

```ts
import { approvals } from "@agentapprovalprotocol/ai-sdk";
import { generateText, type ModelMessage } from "ai";

const gate = new Gate(client, { mode: "async" });
const gated = approvals({ gate });

async function send(threadId: string, messages: ModelMessage[]) {
  const result = await generateText({ model, tools, messages, runtimeContext: { threadId }, ...gated });
  await db.saveMessages(threadId, [...messages, ...result.responseMessages]);
}
```

When a call waits for its decision, the run ends with a `tool-approval-request`, so your server can respond and the process can exit. Without a thread ID, calls wait instead of pausing.

With `ToolLoopAgent`, pass the thread ID as a call option:

```ts
const agent = new ToolLoopAgent({
  model,
  tools,
  callOptionsSchema: z.object({ threadId: z.string() }),
  prepareCall: ({ options, ...settings }) => ({ ...settings, runtimeContext: { threadId: options.threadId } }),
  ...approvals({ gate }),
});

await agent.generate({ messages, options: { threadId } });
```

Give the [receiver](overview.md#resume-paused-runs) an AI SDK resumer:

```ts
import { resumer } from "@agentapprovalprotocol/ai-sdk";

const resumers = { "ai-sdk": resumer({ load: db.loadMessages, save: db.saveMessages, run: send }) };
```

When the decision arrives, the resumer adds it to the thread and calls `send` again. If several calls paused in one step, it waits until all of them are decided.

## Chat apps

Load the conversation from your server instead of trusting the history the browser sends. Approvals sent from the browser, such as `addToolApprovalResponse` in `useChat`, cannot approve a call. The provider is asked again, and a call that is still waiting is denied. Show the request as waiting, and let the resumer continue the thread.

## Sub-agents

Sub-agents cannot pause, and `approvals` does not reach them. Give each sub-agent tools wrapped with `gatedTools`, so each call waits for its decision:

```ts
import { gatedTools } from "@agentapprovalprotocol/ai-sdk";

const researcher = new ToolLoopAgent({ model, tools: gatedTools(tools, { gate }) });
```

Use `gatedTools` too for tools that other tools call, such as tools reached through `experimental_toolCallers`. `approvals` leaves gated tools to their own gate, so no call is sent twice.

## Limitations

- **Tools that run at the model provider:** Tools such as provider web search cannot wait for approval. `approvals` and `gatedTools` refuse a tool set that contains one. Remove them, or use a tool with its own `execute`.
- **Parallel calls:** Calls the model makes in parallel are checked one at a time. In wait mode, the second call waits until the first is decided.
- **Tools without `execute`:** These run in the browser. They are approved, but their outcome is not reported.
- **`WorkflowAgent`:** `WorkflowAgent` from `@ai-sdk/workflow` is not supported yet. Use `ToolLoopAgent`, `generateText` or `streamText`.

## Test without a provider

Pass a gate built on [`FakeProvider`](overview.md#test-without-a-provider):

```ts
import { Gate } from "@agentapprovalprotocol/sdk";
import { FakeProvider } from "@agentapprovalprotocol/sdk/testing";

const provider = new FakeProvider();
const gated = approvals({ gate: new Gate(provider.client()) });
```
