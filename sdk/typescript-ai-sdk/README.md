# Agent Approval Protocol for the Vercel AI SDK

Put every tool call your [AI SDK](https://ai-sdk.dev) agent makes behind an [AAP](https://agentapprovalprotocol.io) approval provider. A call runs only if the provider approves it, and runs at most once. A denied call returns the reason to the model.

```sh
npm install @agentapprovalprotocol/ai-sdk @agentapprovalprotocol/sdk ai
```

It needs AI SDK 7 and Node.js 22 or later.

## Gate every tool call

```ts
import { Client, Gate } from "@agentapprovalprotocol/sdk";
import { approvals } from "@agentapprovalprotocol/ai-sdk";

const gate = new Gate(new Client("https://approvals.example.com/api/aap", token));

const agent = new ToolLoopAgent({ model, tools, ...approvals({ gate }) });
```

`approvals` works the same with `generateText` and `streamText`. It sets `toolApproval` and `onToolExecutionEnd`. If you have your own `onToolExecutionEnd`, call the one from `approvals` inside it, so outcomes are still reported.

Each call waits for the decision. Every tool is covered, including MCP tools.

## Pause instead of waiting

With `new Gate(client, { mode: "async" })`, a call with no decision yet ends the run with a `tool-approval-request`, so your server can respond and the process can exit. When the decision arrives, a `Receiver` continues the thread.

For this, every run needs a thread ID in `runtimeContext.threadId`, and you store each thread's messages on your server:

```ts
import { Receiver } from "@agentapprovalprotocol/sdk";
import { resumer } from "@agentapprovalprotocol/ai-sdk";

const gated = approvals({ gate });

async function send(threadId: string, messages: ModelMessage[]) {
  const result = await generateText({ model, tools, messages, runtimeContext: { threadId }, ...gated });
  await db.saveMessages(threadId, [...messages, ...result.responseMessages]);
}

const receiver = new Receiver({
  resumers: {
    "ai-sdk": resumer({ load: db.loadMessages, save: db.saveMessages, run: send }),
  },
});
```

Serve the receiver where the provider can reach it, then register it with `receiver.provision(...)` or in your provider's app. On later starts, pass the saved secret, registration ID and client. See [pausing in the TypeScript SDK](../typescript/README.md#pause-instead-of-waiting).

The resumer adds the decision to the thread and calls `send` again. If several calls are paused in one step, it waits until all of them are decided. Without a thread ID, calls wait instead of pausing.

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

## Chat apps

Load the conversation from your server instead of trusting the history the browser sends. Approvals sent from the browser, such as `addToolApprovalResponse` in `useChat`, cannot approve a call: the provider is asked again, and a call that is still waiting is denied. Show the request as waiting, and let the resumer continue the thread.

## Sub-agents

Sub-agents cannot pause. Give a sub-agent tools wrapped with `gatedTools`, so each call waits for its decision:

```ts
import { gatedTools } from "@agentapprovalprotocol/ai-sdk";

const researcher = new ToolLoopAgent({ model, tools: gatedTools(tools, { gate }) });
```

Use `gatedTools` too for tools that other tools call, such as tools reached through `experimental_toolCallers`. `approvals` leaves gated tools to their own gate, so no call is sent twice.

## Limitations

- Tools that run at the model provider, such as provider web search, cannot wait for approval. `approvals` and `gatedTools` refuse a tool set that contains one.
- Calls the model makes in parallel are checked one at a time. With a sync gate, the second call waits until the first is decided.
- Tools without an `execute` function run in the browser. They are approved, but their outcome is not reported.
- `WorkflowAgent` from `@ai-sdk/workflow` is not supported yet.
