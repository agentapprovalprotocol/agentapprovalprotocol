# Agent Approval Protocol for TypeScript

Put an AI agent's tool calls behind an [AAP](https://agentapprovalprotocol.io) approval provider. Each call waits for the provider's decision, runs only if approved, and runs at most once.

```sh
npm install @agentapprovalprotocol/sdk
```

It has no dependencies and uses only Web-standard APIs (`fetch` and Web Crypto). On Node.js it needs version 20 or later.

## Check a tool call

```ts
import { Client, Gate } from "@agentapprovalprotocol/sdk";

const gate = new Gate(new Client("https://approvals.example.com/api/aap", token));

const result = await gate.guard(
  { key: `${runId}:${toolCall.id}`, tool: toolCall.name, arguments: toolCall.args },
  () => runTool(toolCall),
);
const output = result.kind === "allow" ? result.value : result.reason; // return a denial's reason to the model
```

`key` must identify the tool call within its run, and stay the same if the call is seen again after a retry or resume. `guard` runs the tool only when the call is approved, and reports whether it succeeded.

To run the tool yourself, use `gate.check(call)`. It returns a verdict whose `kind` is `allow`, `deny` or `pending`. After an allow, call `verdict.report("succeeded")` or `verdict.report("failed")`.

## Pause instead of waiting

With `new Gate(client, { mode: "async" })`, `check` returns a `pending` verdict when there is no decision yet, so the run can pause and the process can exit. Mount a `Receiver` where the provider can reach it. When a decision arrives it wakes the run, and the gate checks the decision again before anything runs.

```ts
import { Receiver } from "@agentapprovalprotocol/sdk";

const receiver = new Receiver({ secret, client, resumers: { myframework: resumeRun } });

export const POST = receiver.handler; // a Next.js route handler
```

`receiver.handler` takes a `Request` and returns a `Response`, the interface Hono, Bun, Deno and Workers also use. On Node.js `http` or Express, use `nodeListener(receiver)` from `@agentapprovalprotocol/sdk/node`. On serverless platforms, pass `waitUntil` so the run can resume after the response is sent.

## Testing

`FakeProvider` from `@agentapprovalprotocol/sdk/testing` is an in-memory provider. Use `provider.client()` in place of a real client, and `provider.decide(requestId, "approved")` to decide a request.

## Limitations

Tool arguments are compared with the provider's copy exactly, including large numbers. Requests the SDK returns to you use JavaScript numbers, so integers beyond 2^53 lose precision there. Pass a `bigint` to send such an integer exactly.
