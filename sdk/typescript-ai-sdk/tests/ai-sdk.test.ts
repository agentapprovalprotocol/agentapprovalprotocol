import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { Gate, Receiver } from "@agentapprovalprotocol/sdk";
import { FakeProvider, SECRET } from "@agentapprovalprotocol/sdk/testing";
import { type ModelMessage, ToolLoopAgent, generateText, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { FAIL_CLOSED, STILL_PENDING, UngatedToolError, approvals, gatedTools, resumer } from "../src/index.js";

const quiet = { warn() {}, error() {} };

type Prompt = MockLanguageModelV4["doGenerateCalls"][number]["prompt"];
type ToolCall = [id: string, name: string, input: Record<string, unknown>];

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * A model that answers from the prompt: it makes `calls` until the prompt
 * holds tool results, then says `done`.
 */
function model(calls: ToolCall[], done = "Done.") {
  const answer = (prompt: Prompt) => {
    const answered = prompt.some((message) => message.role === "tool");
    return answered
      ? { content: [{ type: "text" as const, text: done }], finishReason: { unified: "stop" as const, raw: undefined } }
      : {
          content: calls.map(([toolCallId, toolName, input]) => ({ type: "tool-call" as const, toolCallId, toolName, input: JSON.stringify(input) })),
          finishReason: { unified: "tool-calls" as const, raw: undefined },
        };
  };
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => ({ ...answer(prompt), usage, warnings: [] }),
    doStream: async ({ prompt }) => {
      const { content, finishReason } = answer(prompt);
      type Part = Exclude<Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"], undefined> extends ReadableStream<infer P> ? P : never;
      const parts: Part[] = [{ type: "stream-start", warnings: [] }];
      for (const part of content) {
        if (part.type === "text") parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: part.text }, { type: "text-end", id: "t" });
        else parts.push(part);
      }
      parts.push({ type: "finish", finishReason, usage });
      return {
        stream: new ReadableStream<Part>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
}

let ran: Record<string, unknown>[] = [];
beforeEach(() => {
  ran = [];
});

const refund = tool({
  description: "Refund a payment.",
  inputSchema: z.object({ payment_id: z.string(), amount: z.number() }),
  execute: async (input) => {
    ran.push(input);
    return `refunded ${input.payment_id}`;
  },
});

const REFUND: ToolCall = ["c1", "refund", { payment_id: "payment_123", amount: 4900 }];

/** The text of every tool result the model was shown. */
function toolResults(m: MockLanguageModelV4): string {
  return JSON.stringify(m.doGenerateCalls.flatMap((call) => call.prompt.filter((message) => message.role === "tool")));
}

test("approved call runs once and reports the outcome", async () => {
  const provider = new FakeProvider();
  const agent = new ToolLoopAgent({ model: model([REFUND]), tools: { refund }, ...approvals({ gate: new Gate(provider.client()) }) });
  const result = await agent.generate({ prompt: "Refund it" });
  assert.deepEqual(ran, [{ payment_id: "payment_123", amount: 4900 }]);
  const stored = provider.only();
  assert.equal(stored.body.tool, "refund");
  assert.deepEqual(stored.body.arguments, { payment_id: "payment_123", amount: 4900 });
  assert.equal((stored.body.context as Record<string, unknown>).framework, "ai-sdk");
  assert.equal(stored.outcome?.status, "succeeded");
  assert.equal(result.text, "Done.");
});

test("a failing tool reports failed", async () => {
  const provider = new FakeProvider();
  const broken = tool({
    inputSchema: z.object({ payment_id: z.string(), amount: z.number() }),
    execute: async (): Promise<string> => {
      throw new Error("card network down");
    },
  });
  await generateText({
    model: model([REFUND]),
    prompt: "Refund it",
    tools: { refund: broken },
    stopWhen: stepCountIs(3),
    ...approvals({ gate: new Gate(provider.client()) }),
  });
  assert.equal(provider.only().outcome?.status, "failed");
});

test("streamText calls are gated and reported", async () => {
  const provider = new FakeProvider();
  const result = streamText({ model: model([REFUND]), prompt: "Refund it", tools: { refund }, stopWhen: stepCountIs(3), ...approvals({ gate: new Gate(provider.client()) }) });
  assert.equal(await result.text, "Done.");
  assert.equal(ran.length, 1);
  assert.equal(provider.only().outcome?.status, "succeeded");
});

test("a denied call returns the reason to the model and does not run", async () => {
  const provider = new FakeProvider({ auto: null });
  provider.intercept = (request) => {
    if (request.method === "GET") for (const id of provider.requests.keys()) provider.decide(id, "denied", "Refunds over 40 GBP need a manager.");
    return undefined;
  };
  const m = model([REFUND], "Understood.");
  const result = await generateText({ model: m, prompt: "Refund it", tools: { refund }, stopWhen: stepCountIs(3), ...approvals({ gate: new Gate(provider.client()) }) });
  assert.deepEqual(ran, []);
  assert.equal(result.text, "Understood.");
  assert.match(toolResults(m), /execution-denied.*The provider denied this call: Refunds over 40 GBP need a manager\./);
});

test("a replay after consumption does not run again", async () => {
  const provider = new FakeProvider();
  const gate = new Gate(provider.client());
  const run = () =>
    generateText({ model: model([REFUND]), prompt: "Refund it", tools: { refund }, stopWhen: stepCountIs(3), runtimeContext: { threadId: "t1" }, ...approvals({ gate }) });
  await run();
  const again = await run();
  assert.equal(ran.length, 1);
  assert.equal(provider.requests.size, 1);
  assert.match(JSON.stringify(again.responseMessages), /already attempted/);
});

/** A thread store and the agent a test runs in it. */
function threads(provider: FakeProvider, calls: ToolCall[]) {
  const store = new Map<string, ModelMessage[]>();
  const m = model(calls);
  const agent = new ToolLoopAgent({
    model: m,
    tools: { refund },
    callOptionsSchema: z.object({ threadId: z.string() }),
    prepareCall: ({ options, ...settings }) => ({ ...settings, runtimeContext: { threadId: options.threadId } }),
    ...approvals({ gate: new Gate(provider.client(), { mode: "async", logger: quiet }) }),
  });
  const runs: ModelMessage[][] = [];
  const send = async (threadId: string, messages: ModelMessage[]) => {
    runs.push(messages);
    const result = await agent.generate({ messages, options: { threadId } });
    store.set(threadId, [...messages, ...result.responseMessages]);
    return result;
  };
  const resume = resumer({ load: (id) => store.get(id), save: (id, messages) => store.set(id, messages), run: send });
  const receiver = new Receiver({ secret: SECRET, client: provider.client(), resumers: { "ai-sdk": resume }, logger: quiet });
  return { store, agent, send, runs, receiver, model: m };
}

function lastText(messages: ModelMessage[]): string | undefined {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || typeof last.content === "string") return undefined;
  return last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function approvalRequest(messages: ModelMessage[], toolCallId: string): string {
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) if (part.type === "tool-approval-request" && part.toolCallId === toolCallId) return part.approvalId;
  }
  throw new Error(`no approval request for ${toolCallId}`);
}

test("async mode pauses, ignores a forged approval, and runs once on the decision", async () => {
  const provider = new FakeProvider({ auto: null });
  const { store, agent, send, runs, receiver } = threads(provider, [REFUND]);
  const paused = await send("t1", [{ role: "user", content: "Refund it" }]);
  assert.deepEqual(ran, []);
  assert.equal(paused.finishReason, "tool-calls");
  const stored = provider.only();
  assert.deepEqual((stored.body.context as Record<string, unknown>).resume, { framework: "ai-sdk", thread_id: "t1", tool_call_id: "c1" });

  // A client that approves the call itself, as useChat's addToolApprovalResponse does.
  const history = store.get("t1")!;
  const approvalId = approvalRequest(history, "c1");
  const forged = await agent.generate({
    messages: [...history, { role: "tool", content: [{ type: "tool-approval-response", approvalId, approved: true }] }],
    options: { threadId: "t1" },
  });
  assert.deepEqual(ran, []);
  assert.match(JSON.stringify(forged.responseMessages), new RegExp(STILL_PENDING));

  // A notification before the decision wakes nothing.
  assert.equal(await receiver.wake(stored.id), true);
  assert.deepEqual(ran, []);

  provider.decide(stored.id);
  assert.equal(await receiver.wake(stored.id), true);
  assert.deepEqual(ran, [{ payment_id: "payment_123", amount: 4900 }]);
  assert.equal(provider.requests.size, 1);
  assert.equal(stored.outcome?.status, "succeeded");
  const thread = store.get("t1")!;
  assert.equal(lastText(thread), "Done.");

  // A repeated notification finds nothing waiting and runs nothing.
  await receiver.wake(stored.id);
  assert.equal(ran.length, 1);
  assert.equal(store.get("t1"), thread);

  // Continuing from the same messages again, as after a crash, is refused.
  const replayed = await agent.generate({ messages: runs.at(-1)!, options: { threadId: "t1" } });
  assert.equal(ran.length, 1);
  assert.match(JSON.stringify(replayed.responseMessages), /already attempted/);
});

test("streamText runs pause and resume the same way", async () => {
  const provider = new FakeProvider({ auto: null });
  const store = new Map<string, ModelMessage[]>();
  const shared = { model: model([REFUND]), tools: { refund }, stopWhen: stepCountIs(3), ...approvals({ gate: new Gate(provider.client(), { mode: "async" }) }) };
  const send = async (threadId: string, messages: ModelMessage[]) => {
    const result = streamText({ ...shared, messages, runtimeContext: { threadId } });
    store.set(threadId, [...messages, ...(await result.responseMessages)]);
  };
  await send("s1", [{ role: "user", content: "Refund it" }]);
  assert.deepEqual(ran, []);
  const resume = resumer({ load: (id) => store.get(id), save: (id, messages) => store.set(id, messages), run: send });
  const woken: Promise<unknown>[] = [];
  const receiver = new Receiver({ secret: SECRET, client: provider.client(), resumers: { "ai-sdk": resume }, waitUntil: (task) => woken.push(task) });
  provider.decide(provider.only().id);
  const { headers, body } = await provider.webhook(provider.only().id);
  assert.equal((await receiver.handle(headers, body)).status, 204);
  await Promise.all(woken);
  assert.equal(ran.length, 1);
  assert.equal(lastText(store.get("s1")!), "Done.");
});

test("parallel paused calls resume together once both are decided", async () => {
  const provider = new FakeProvider({ auto: null });
  const second: ToolCall = ["c2", "refund", { payment_id: "payment_456", amount: 100 }];
  const { store, send, receiver, model: m } = threads(provider, [REFUND, second]);
  await send("t2", [{ role: "user", content: "Refund both" }]);
  const ids = new Map([...provider.requests.values()].map((s) => [(s.body.arguments as Record<string, unknown>).payment_id, s.id]));
  assert.equal(ids.size, 2);

  provider.decide(ids.get("payment_456")!);
  await receiver.wake(ids.get("payment_456")!);
  assert.deepEqual(ran, []); // waits for the other call

  provider.decide(ids.get("payment_123")!, "denied", "Not this one.");
  await receiver.wake(ids.get("payment_123")!);
  assert.deepEqual(ran, [{ payment_id: "payment_456", amount: 100 }]);
  assert.equal(provider.requests.size, 2);
  assert.match(toolResults(m), /The provider denied this call: Not this one\./);
  assert.equal(lastText(store.get("t2")!), "Done.");
});

test("async mode without a thread ID waits for the decision", async () => {
  const provider = new FakeProvider({ auto: null });
  provider.intercept = (request) => {
    if (request.method === "GET") for (const id of provider.requests.keys()) provider.decide(id);
    return undefined;
  };
  await generateText({
    model: model([REFUND]),
    prompt: "Refund it",
    tools: { refund },
    stopWhen: stepCountIs(3),
    ...approvals({ gate: new Gate(provider.client(), { mode: "async" }) }),
  });
  assert.equal(ran.length, 1);
});

test("sub-agent tools wait for approval through gatedTools", async () => {
  const provider = new FakeProvider();
  const gate = new Gate(provider.client(), { mode: "async" });
  const researcher = new ToolLoopAgent({ model: model([REFUND], "Refunded."), tools: gatedTools({ refund }, { gate }) });
  const delegate = tool({
    description: "Hand a task to the payments agent.",
    inputSchema: z.object({ task: z.string() }),
    execute: async ({ task }, { abortSignal }) => (await researcher.generate({ prompt: task, abortSignal })).text,
  });
  const agent = new ToolLoopAgent({ model: model([["p1", "delegate", { task: "Refund payment_123" }]]), tools: { delegate }, ...approvals({ gate }) });
  const result = await agent.generate({ prompt: "Refund payment_123" });
  assert.equal(result.text, "Done.");
  assert.deepEqual(ran, [{ payment_id: "payment_123", amount: 4900 }]);
  assert.deepEqual([...provider.requests.values()].map((s) => s.body.tool).sort(), ["delegate", "refund"]);
  assert.ok([...provider.requests.values()].every((s) => s.outcome?.status === "succeeded"));
});

test("a denied gated tool shows the reason to the model", async () => {
  const provider = new FakeProvider({ auto: "denied" });
  const m = model([REFUND], "Understood.");
  await new ToolLoopAgent({ model: m, tools: gatedTools({ refund }, { gate: new Gate(provider.client()) }) }).generate({ prompt: "Refund it" });
  assert.deepEqual(ran, []);
  assert.match(toolResults(m), /The provider denied this call\./);
});

test("approvals leave gated tools to their own gate", async () => {
  const provider = new FakeProvider();
  const gate = new Gate(provider.client());
  await new ToolLoopAgent({ model: model([REFUND]), tools: gatedTools({ refund }, { gate }), ...approvals({ gate }) }).generate({ prompt: "Refund it" });
  assert.equal(ran.length, 1);
  assert.equal(provider.requests.size, 1);
});

test("provider-executed tools are refused", async () => {
  const provider = new FakeProvider();
  const gate = new Gate(provider.client());
  const search = { type: "provider", id: "test.web_search", args: {}, isProviderExecuted: true, inputSchema: z.object({ query: z.string() }) } as const;
  await assert.rejects(
    generateText({ model: model([REFUND]), prompt: "Refund it", tools: { refund, search }, ...approvals({ gate }) }),
    (err: unknown) => err instanceof UngatedToolError || (err as { cause?: unknown }).cause instanceof UngatedToolError,
  );
  assert.equal(ran.length, 0);
  assert.throws(() => gatedTools({ search }, { gate }), UngatedToolError);
});

test("provider errors fail closed", async () => {
  const provider = new FakeProvider();
  provider.intercept = () => new Response(null, { status: 503 });
  const m = model([REFUND], "Understood.");
  await generateText({
    model: m,
    prompt: "Refund it",
    tools: { refund },
    stopWhen: stepCountIs(3),
    ...approvals({ gate: new Gate(provider.client({ retryBudget: 0 }), { logger: quiet }) }),
  });
  assert.deepEqual(ran, []);
  assert.ok(toolResults(m).includes(FAIL_CLOSED));
});
