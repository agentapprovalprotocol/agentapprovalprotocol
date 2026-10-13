import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { Gate, Receiver } from "@agentapprovalprotocol/sdk";
import { FakeProvider, SECRET } from "@agentapprovalprotocol/sdk/testing";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import type { MastraModelConfig } from "@mastra/core/llm";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { Approvals, PAUSE_KEY, resumer } from "../src/index.js";

type ToolCall = [id: string, name: string, args: Record<string, unknown>];
interface Turn {
  text?: string;
  calls?: ToolCall[];
}

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

/** A language model, as Mastra accepts it, that also records each prompt it was sent. */
type Scripted = Extract<MastraModelConfig, { doStream: unknown }> & { prompts: unknown[][] };

/** A language model that replays scripted turns. */
function scripted(...turns: Turn[]): Scripted {
  const prompts: unknown[][] = [];
  const next = (prompt: unknown[]) => {
    prompts.push(prompt);
    const turn = turns.shift();
    if (turn === undefined) throw new Error("the model ran out of scripted turns");
    const content: Record<string, unknown>[] = [];
    if (turn.text) content.push({ type: "text", text: turn.text });
    for (const [toolCallId, toolName, args] of turn.calls ?? []) content.push({ type: "tool-call", toolCallId, toolName, input: JSON.stringify(args) });
    return { content, finishReason: { unified: turn.calls?.length ? "tool-calls" : "stop", raw: undefined }, usage, warnings: [] };
  };
  const model = {
    prompts,
    specificationVersion: "v3" as const,
    provider: "scripted",
    modelId: "scripted",
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown[] }) {
      return next(options.prompt);
    },
    async doStream(options: { prompt: unknown[] }) {
      const { content, finishReason } = next(options.prompt);
      const parts: Record<string, unknown>[] = [{ type: "stream-start", warnings: [] }];
      for (const part of content) {
        if (part.type === "text") parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: part.text }, { type: "text-end", id: "t" });
        else parts.push(part);
      }
      parts.push({ type: "finish", finishReason, usage });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return model as unknown as Scripted;
}

let ran: Record<string, unknown>[] = [];
beforeEach(() => {
  ran = [];
});

const refund = createTool({
  id: "refund",
  description: "Refund a payment.",
  inputSchema: z.object({ payment_id: z.string(), amount: z.number() }),
  execute: async (input) => {
    ran.push(input);
    if (input.amount < 0) throw new Error("negative refund");
    return `refunded ${input.payment_id}`;
  },
});

const REFUND: ToolCall = ["c1", "refund", { payment_id: "payment_123", amount: 4900 }];
const quiet = { warn() {}, error() {} };

function setup(provider: FakeProvider, model: Scripted, options: { mode?: "sync" | "async"; storage?: InMemoryStore; approvals?: Approvals } = {}) {
  const approvals = options.approvals ?? new Approvals(new Gate(provider.client({ retryBudget: 0 }), { mode: options.mode, logger: quiet }), { logger: quiet });
  const agent = new Agent(approvals.config({ id: "support", name: "Support", instructions: "Help customers.", model, tools: { refund } }));
  const mastra = new Mastra({ agents: { support: agent }, storage: options.storage ?? new InMemoryStore(), logger: false });
  return { approvals, agent: mastra.getAgent("support") };
}

/** The tool results the model was sent in its last prompt. */
function toolResults(model: Scripted): unknown[] {
  const prompt = model.prompts.at(-1) as { role: string; content: { type: string; output?: unknown }[] }[];
  return prompt.filter((m) => m.role === "tool").flatMap((m) => m.content.filter((p) => p.type === "tool-result").map((p) => p.output));
}

test("an approved call runs once and reports its outcome", async () => {
  const provider = new FakeProvider();
  const model = scripted({ text: "The customer was charged twice.", calls: [REFUND] }, { text: "Done." });
  const { agent } = setup(provider, model);
  const result = await agent.generate("Refund payment_123");
  assert.deepEqual(ran, [{ payment_id: "payment_123", amount: 4900 }]);
  assert.equal(result.text.endsWith("Done."), true);
  const stored = provider.only();
  assert.equal(stored.body.tool, "refund");
  assert.deepEqual(stored.body.arguments, { payment_id: "payment_123", amount: 4900 });
  assert.equal(stored.body.agent_reasoning, "The customer was charged twice.");
  const context = stored.body.context as Record<string, unknown>;
  assert.equal(context.framework, "mastra");
  assert.deepEqual(context.resume, { framework: "mastra", agent_id: "support", tool_call_id: "c1" });
  assert.equal(stored.outcome?.status, "succeeded");
});

test("a tool that throws reports failed", async () => {
  const provider = new FakeProvider();
  const model = scripted({ calls: [["c1", "refund", { payment_id: "payment_123", amount: -1 }]] }, { text: "It failed." });
  const { agent } = setup(provider, model);
  await agent.generate("Refund it");
  assert.equal(ran.length, 1);
  assert.equal(provider.only().outcome?.status, "failed");
});

test("a denied call returns the reason to the model and does not run", async () => {
  const provider = new FakeProvider({ auto: null });
  provider.intercept = (request) => {
    // The reviewer denies the request while the gate waits.
    if (request.method === "GET") for (const stored of provider.requests.values()) provider.decide(stored.id, "denied", "Refunds over 40 GBP need a manager.");
    return undefined;
  };
  const model = scripted({ calls: [REFUND] }, { text: "I could not refund it." });
  const { agent } = setup(provider, model);
  await agent.generate("Refund it");
  assert.deepEqual(ran, []);
  assert.match(JSON.stringify(toolResults(model)), /Approval for this call was denied, so it was not run\. Reason: Refunds over 40 GBP need a manager\./);
});

test("a replayed call is refused after its approval was consumed", async () => {
  const provider = new FakeProvider();
  const approvals = new Approvals(new Gate(provider.client()), { logger: quiet });
  const seen: Parameters<Approvals["hooks"]["beforeToolCall"]>[0][] = [];
  const agent = new Agent({
    id: "support",
    name: "Support",
    instructions: "Help customers.",
    model: scripted({ calls: [REFUND] }, { text: "Done." }),
    tools: { refund },
    hooks: {
      beforeToolCall: (hook) => {
        seen.push(hook);
        return approvals.hooks.beforeToolCall(hook);
      },
      afterToolCall: approvals.hooks.afterToolCall,
    },
  });
  await agent.generate("Refund it");
  assert.equal(ran.length, 1);
  // Mastra running the same call again, here or in another process, finds the approval used.
  await assert.rejects(approvals.hooks.beforeToolCall(seen[0]!), /already attempted/);
  const other = new Approvals(new Gate(provider.client()), { logger: quiet });
  await assert.rejects(other.hooks.beforeToolCall(seen[0]!), /already attempted/);
  assert.equal(ran.length, 1);
  assert.equal(provider.requests.size, 1);
});

test("provider errors fail closed", async () => {
  const provider = new FakeProvider();
  provider.intercept = () => new Response(null, { status: 503 });
  const model = scripted({ calls: [REFUND] }, { text: "Sorry." });
  const { agent } = setup(provider, model);
  await agent.generate("Refund it");
  assert.deepEqual(ran, []);
  assert.match(JSON.stringify(toolResults(model)), /could not obtain a valid AAP decision/);
});

test("async mode pauses, ignores forged approvals and resumes on the decision", async () => {
  const provider = new FakeProvider({ auto: null });
  const model = scripted({ text: "Charged twice.", calls: [REFUND] }, { text: "Done." });
  const { agent } = setup(provider, model, { mode: "async" });
  const paused = await agent.generate("Refund it");
  assert.equal(paused.finishReason, "suspended");
  const requestId = (paused.suspendPayload as { suspendPayload: Record<string, string> }).suspendPayload[PAUSE_KEY]!;
  assert.deepEqual(ran, []);
  assert.equal(provider.requests.get(requestId)?.status, "pending");

  // Mastra's own approval and resume calls cannot approve the call.
  const forged = await agent.approveToolCallGenerate({ runId: paused.runId!, toolCallId: "c1" });
  assert.equal(forged.finishReason, "suspended");
  const resumed = await agent.resumeGenerate({ approved: true }, { runId: paused.runId, toolCallId: "c1" });
  assert.equal(resumed.finishReason, "suspended");
  assert.deepEqual(ran, []);

  provider.decide(requestId);
  const results: string[] = [];
  const receiver = new Receiver({ secret: SECRET, client: provider.client(), resumers: { mastra: resumer(agent, { onResult: async (output) => void results.push(await output.text) }) } });
  assert.equal(await receiver.wake(requestId), true);
  assert.deepEqual(ran, [{ payment_id: "payment_123", amount: 4900 }]);
  assert.equal(provider.requests.size, 1);
  assert.equal(provider.only().outcome?.status, "succeeded");
  assert.equal(results.length, 1);
  assert.match(results[0]!, /Done\.$/);
  // A repeated notification finds nothing waiting and runs nothing.
  await receiver.wake(requestId);
  assert.equal(ran.length, 1);
});

test("a paused run resumes after a restart", async () => {
  const provider = new FakeProvider({ auto: null });
  const storage = new InMemoryStore();
  const first = setup(provider, scripted({ text: "Charged twice.", calls: [REFUND] }), { mode: "async", storage });
  const paused = await first.agent.generate("Refund it");
  assert.equal(paused.finishReason, "suspended");
  const requestId = provider.only().id;

  // A new process: new agent objects over the same storage.
  const second = setup(provider, scripted({ text: "Done." }), { mode: "async", storage });
  provider.decide(requestId);
  const receiver = new Receiver({ secret: SECRET, client: provider.client(), resumers: { mastra: resumer(second.agent) } });
  assert.equal(await receiver.wake(requestId), true);
  assert.equal(ran.length, 1);
  assert.equal(provider.requests.size, 1);
});

test("a streamed run sends the reasoning and resumes with one request", async () => {
  const provider = new FakeProvider({ auto: null });
  const { agent } = setup(provider, scripted({ text: "Charged twice.", calls: [REFUND] }, { text: "Done." }), { mode: "async" });
  const stream = await agent.stream("Refund it");
  await stream.consumeStream();
  assert.equal(await stream.finishReason, "suspended");
  const stored = provider.only();
  assert.equal(stored.body.agent_reasoning, "Charged twice.");
  provider.decide(stored.id);
  const receiver = new Receiver({ secret: SECRET, client: provider.client(), resumers: { mastra: resumer(agent) } });
  assert.equal(await receiver.wake(stored.id), true);
  assert.equal(ran.length, 1);
  assert.equal(provider.requests.size, 1);
});

test("a streamed run with eager tool execution still resumes with one request", async () => {
  const provider = new FakeProvider({ auto: null });
  const approvals = new Approvals(new Gate(provider.client(), { mode: "async" }), { logger: quiet });
  const eager = new Agent({ id: "support", name: "Support", instructions: "Help.", model: scripted({ text: "Charged twice.", calls: [REFUND] }, { text: "Done." }), tools: { refund }, hooks: approvals.hooks });
  const agent = new Mastra({ agents: { support: eager }, storage: new InMemoryStore(), logger: false }).getAgent("support");
  const stream = await agent.stream("Refund it");
  await stream.consumeStream();
  assert.equal(await stream.finishReason, "suspended");
  const stored = provider.only();
  provider.decide(stored.id);
  await new Receiver({ secret: SECRET, client: provider.client(), resumers: { mastra: resumer(agent) } }).wake(stored.id);
  assert.equal(ran.length, 1);
  assert.equal(provider.requests.size, 1);
});

test("parallel calls wait for their own decisions", async () => {
  const provider = new FakeProvider({ auto: null });
  const second: ToolCall = ["c2", "refund", { payment_id: "payment_456", amount: 100 }];
  const model = scripted({ calls: [REFUND, second] }, { text: "Both handled." });
  const { agent } = setup(provider, model, { mode: "async" });
  const paused = await agent.generate("Refund both");
  assert.equal(paused.finishReason, "suspended");
  const ids = Object.fromEntries([...provider.requests.values()].map((stored) => [(stored.body.context as { resume: { tool_call_id: string } }).resume.tool_call_id, stored.id]));
  assert.deepEqual(Object.keys(ids).sort(), ["c1", "c2"]);
  const receiver = new Receiver({ secret: SECRET, client: provider.client(), resumers: { mastra: resumer(agent) } });

  provider.decide(ids.c2!);
  await receiver.wake(ids.c2!);
  assert.deepEqual(ran, [{ payment_id: "payment_456", amount: 100 }]);

  provider.decide(ids.c1!, "denied", "Not this one.");
  await receiver.wake(ids.c1!);
  assert.equal(ran.length, 1);
  assert.equal((await agent.listSuspendedRuns()).runs.length, 0);
  assert.match(JSON.stringify(toolResults(model)), /Not this one\./);
  assert.equal(provider.requests.size, 2);
});

test("an approved tool that suspends itself continues without a second request", async () => {
  const provider = new FakeProvider();
  const confirm = createTool({
    id: "confirm",
    description: "Ask the customer to confirm, then refund.",
    inputSchema: z.object({ payment_id: z.string() }),
    execute: async (input, context) => {
      const answer = context.agent?.resumeData as { confirmed?: boolean } | undefined;
      if (answer === undefined) return context.agent?.suspend?.({ question: "Confirm the refund?" });
      ran.push({ ...input, ...answer });
      return "refunded";
    },
  });
  const approvals = new Approvals(new Gate(provider.client()), { logger: quiet });
  const agent = new Agent({ id: "support", name: "Support", instructions: "Help.", model: scripted({ calls: [["c1", "confirm", { payment_id: "payment_123" }]] }, { text: "Done." }), tools: { confirm }, hooks: approvals.hooks });
  const mastra = new Mastra({ agents: { support: agent }, storage: new InMemoryStore(), logger: false });
  const support = mastra.getAgent("support");
  const paused = await support.generate("Refund it");
  assert.equal(paused.finishReason, "suspended");
  assert.equal((paused.suspendPayload as { suspendPayload: { question: string } }).suspendPayload.question, "Confirm the refund?");
  assert.equal(provider.only().outcome, undefined);
  await support.resumeGenerate({ confirmed: true }, { runId: paused.runId, toolCallId: "c1" });
  assert.deepEqual(ran, [{ payment_id: "payment_123", confirmed: true }]);
  assert.equal(provider.requests.size, 1);
  assert.equal(provider.only().outcome?.status, "succeeded");
});

function team(provider: FakeProvider, mode: "sync" | "async") {
  const approvals = new Approvals(new Gate(provider.client(), { mode, logger: quiet }), { logger: quiet });
  const billing = new Agent(
    approvals.config({
      id: "billing",
      name: "Billing",
      description: "Handles refunds.",
      instructions: "Refund payments.",
      model: scripted({ text: "Refunding.", calls: [REFUND] }, { text: "Refunded." }),
      tools: { refund },
    }),
  );
  const lead = new Agent(
    approvals.config({
      id: "lead",
      name: "Lead",
      instructions: "Delegate billing work.",
      model: scripted({ calls: [["d1", "agent-billing", { prompt: "Refund payment_123" }]] }, { text: "Billing refunded it." }),
      agents: { billing },
    }),
  );
  const mastra = new Mastra({ agents: { lead, billing }, storage: new InMemoryStore(), logger: false });
  return { approvals, lead: mastra.getAgent("lead"), billing: mastra.getAgent("billing") };
}

test("sub-agent calls are gated", async () => {
  const provider = new FakeProvider();
  const { approvals, lead } = team(provider, "sync");
  await approvals.check(lead);
  await lead.generate("Refund payment_123");
  assert.equal(ran.length, 1);
  assert.deepEqual([...provider.requests.values()].map((stored) => stored.body.tool).sort(), ["agent-billing", "refund"]);
});

test("a paused sub-agent call resumes through its parent", async () => {
  const provider = new FakeProvider({ auto: null });
  const { lead } = team(provider, "async");
  const receiver = new Receiver({ secret: SECRET, client: provider.client(), resumers: { mastra: resumer(lead) } });
  const paused = await lead.generate("Refund payment_123");
  assert.equal(paused.finishReason, "suspended");
  const delegation = provider.only();
  assert.equal(delegation.body.tool, "agent-billing");

  provider.decide(delegation.id);
  await receiver.wake(delegation.id);
  const call = [...provider.requests.values()].find((stored) => stored.body.tool === "refund")!;
  assert.equal(call.status, "pending");
  assert.equal(call.body.agent_reasoning, "Refunding.");
  assert.deepEqual(ran, []);

  provider.decide(call.id);
  await receiver.wake(call.id);
  assert.equal(ran.length, 1);
  assert.equal(provider.requests.size, 2);
  assert.equal(call.outcome?.status, "succeeded");
  assert.equal(delegation.outcome?.status, "succeeded");
  assert.equal((await lead.listSuspendedRuns()).runs.length, 0);
});

test("config refuses hooks that would replace the approval hooks", () => {
  const approvals = new Approvals(new Gate(new FakeProvider().client()));
  assert.throws(() => approvals.config({ id: "a", hooks: { beforeToolCall: () => {} } }), /already has hooks/);
});

test("check finds agents and tools that would not be gated", async () => {
  const provider = new FakeProvider();
  const approvals = new Approvals(new Gate(provider.client()));
  const unguarded = new Agent({ id: "unguarded", name: "Unguarded", description: "No approvals.", instructions: "x", model: scripted(), tools: { refund } });
  const lead = new Agent({
    id: "lead",
    name: "Lead",
    instructions: "x",
    model: scripted(),
    tools: { search: { type: "provider", id: "test.web_search", args: {} } as never },
    agents: { unguarded },
    hooks: approvals.hooks,
  });
  await assert.rejects(approvals.check(lead), (err: Error) => {
    assert.match(err.message, /tool search has no execute/);
    assert.match(err.message, /sub-agent unguarded does not use these approval hooks/);
    return true;
  });
});
