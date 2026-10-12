/**
 * Approvals for Mastra agents.
 *
 * `Approvals` gates every tool call an agent runs through Mastra's
 * `beforeToolCall` hook: assigned tools, MCP toolsets, sub-agents, workflow,
 * memory and workspace tools. In sync mode the call waits for the decision.
 * In async mode the tool suspends the run with Mastra's own suspend, the
 * process can exit, and a `Receiver` resumes the run when the decision
 * arrives. On resume the hook asks the provider again and never reads the
 * resume data, so `approveToolCall`, `resumeStream` or a model-driven resume
 * cannot approve a call.
 */

import type { ApprovalRequest, Call, Gate, JsonObject, Logger, OutcomeStatus, Resumer } from "@agentapprovalprotocol/sdk";
import type { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import type { ToolAfterHookContext, ToolBeforeHookResult, ToolHookContext } from "@mastra/core/tools";

/** The key in a paused call's suspend payload that holds the AAP request ID. */
export const PAUSE_KEY = "aap_request_id";
/** Holds the call's identity in a suspend payload, so a resumed check sends the same request. */
const CALL_KEY = "aap_call";
/** Added to the suspend payload of an approved call that suspends itself, so it can continue on resume. */
const CONTINUES_KEY = "aap_continues";
/** The gate's wording for a call it cannot check. */
const FAIL_CLOSED = "The approval adapter could not obtain a valid AAP decision. The call was not run.";
/** Arguments Mastra adds on resume that are not part of the model's call. */
const INJECTED = new Set(["suspendedToolRunId"]);

/** The fields of Mastra's tool invocation options the hooks use. */
interface Invocation {
  toolCallId?: unknown;
  suspend?: (payload: unknown, options?: unknown) => Promise<unknown>;
  resumeData?: unknown;
  suspendPayload?: unknown;
  getMessages?: () => unknown;
  isBackgroundTask?: unknown;
}

/** What identifies a call to the provider, beyond its tool and arguments. */
interface Identity {
  key: string;
  reasoning?: string;
}

/** A pause or continuation marker in a suspend payload. */
interface Marker {
  requestId: string;
  identity?: Identity;
}

interface Running {
  report(status: OutcomeStatus): Promise<unknown>;
  suspended: boolean;
}

/** The hooks to pass to an agent, as Mastra's `ToolHooks`. */
export interface ApprovalHooks {
  beforeToolCall(hook: ToolHookContext): Promise<void | ToolBeforeHookResult>;
  afterToolCall(hook: ToolAfterHookContext): Promise<void>;
}

export interface ApprovalsOptions {
  /** Context sent with every request, merged over `{ framework: "mastra" }`. */
  context?: Record<string, unknown>;
  logger?: Logger;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function marker(value: unknown): Marker | undefined {
  if (!isRecord(value) || typeof value[PAUSE_KEY] !== "string") return undefined;
  const call = value[CALL_KEY];
  const identity = isRecord(call) && typeof call.key === "string" ? { key: call.key, reasoning: typeof call.reasoning === "string" ? call.reasoning : undefined } : undefined;
  return { requestId: value[PAUSE_KEY], identity };
}

function markerPayload(requestId: string, identity: Identity): Record<string, unknown> {
  return { [PAUSE_KEY]: requestId, [CALL_KEY]: { key: identity.key, ...(identity.reasoning ? { reasoning: identity.reasoning } : {}) } };
}

/**
 * The ID of the assistant message that carries a tool call, and the text the
 * model wrote before the call in the same step. Mastra keeps a response's
 * steps in one message, separated by `step-start` parts.
 */
function carrier(messages: unknown, toolCallId: string): { id?: string; text?: string } {
  if (!Array.isArray(messages)) return {};
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.content) || !Array.isArray(message.content.parts)) continue;
    let text = "";
    for (const part of message.content.parts) {
      if (!isRecord(part)) continue;
      if (part.type === "step-start") text = "";
      else if (part.type === "text" && typeof part.text === "string") text += part.text;
      else if (part.type === "tool-invocation" && isRecord(part.toolInvocation) && part.toolInvocation.toolCallId === toolCallId) {
        return { id: typeof message.id === "string" ? message.id : undefined, text: text.trim() || undefined };
      }
    }
  }
  return {};
}

/**
 * Send every tool call an agent makes to an AAP provider before it runs.
 *
 * Build the agent and every sub-agent with `new Agent(approvals.config({...}))`,
 * then call `approvals.check(agent)` once to confirm nothing is left ungated.
 * Async mode needs storage on the Mastra instance to resume runs after a
 * restart; without it, runs resume only in the same process.
 */
export class Approvals {
  readonly context: Record<string, unknown>;
  readonly hooks: ApprovalHooks;
  readonly #logger: Logger;
  readonly #running = new WeakMap<object, Running>();

  constructor(
    readonly gate: Gate,
    options: ApprovalsOptions = {},
  ) {
    this.context = { framework: "mastra", ...(options.context ?? {}) };
    this.#logger = options.logger ?? console;
    this.hooks = {
      beforeToolCall: (hook) => this.#before(hook),
      afterToolCall: (hook) => this.#after(hook),
    };
  }

  /**
   * An agent config with these hooks installed. It also turns off eager tool
   * execution in streams, which runs tools before the model's message is
   * complete, so the provider receives the model's reasoning.
   */
  config<T extends object>(config: T): T {
    const { hooks, defaultOptions: defaults } = config as { hooks?: unknown; defaultOptions?: unknown };
    if (hooks !== undefined) throw new TypeError("the agent config already has hooks, which would replace the approval hooks");
    const defaultOptions =
      typeof defaults === "function"
        ? async (...args: unknown[]) => ({ ...(await (defaults as (...args: unknown[]) => unknown)(...args) as object), eagerToolExecution: false })
        : { ...(defaults as object | undefined), eagerToolExecution: false };
    return { ...config, hooks: this.hooks, defaultOptions };
  }

  async #before(hook: ToolHookContext): Promise<void | ToolBeforeHookResult> {
    const invocation: Invocation = isRecord(hook.context) ? hook.context : {};
    const toolCallId = invocation.toolCallId;
    if (typeof toolCallId !== "string" || !toolCallId) throw new Error(FAIL_CLOSED);
    const agentId = typeof hook.metadata?.agentId === "string" ? hook.metadata.agentId : "-";
    const previous = invocation.suspendPayload;
    // A continuation marker wraps the payload of an approved call that suspended itself.
    const continues = isRecord(previous) ? marker(previous[CONTINUES_KEY]) : undefined;
    const paused = continues === undefined ? marker(previous) : undefined;
    let identity = continues?.identity ?? paused?.identity;
    if (identity === undefined) {
      let messages: unknown;
      try {
        messages = invocation.getMessages?.();
      } catch {
        messages = undefined;
      }
      const message = carrier(messages, toolCallId);
      identity = { key: `${agentId}:${message.id ?? "-"}:${toolCallId}`, reasoning: message.text };
    }
    const args = isRecord(hook.input) ? Object.fromEntries(Object.entries(hook.input).filter(([key]) => !INJECTED.has(key))) : {};
    const call: Call = {
      key: identity.key,
      tool: hook.toolName,
      arguments: args,
      reasoning: identity.reasoning,
      context: this.context,
      resume: { framework: "mastra", agent_id: agentId, tool_call_id: toolCallId },
    };
    const canPause = typeof invocation.suspend === "function" && invocation.isBackgroundTask !== true;
    const verdict = await this.gate.check(call, { canPause });
    if (verdict.kind === "pending") {
      // The run suspends here. Whatever resumes it, the provider is asked again.
      await invocation.suspend!({ ...markerPayload(verdict.requestId, identity), tool: call.tool });
      return { proceed: false, output: undefined };
    }
    if (verdict.kind === "deny") {
      if (verdict.status !== "consumed" || continues === undefined || continues.requestId !== verdict.requestId) throw new Error(verdict.reason);
      // The approved call suspended itself (a sub-agent or the tool's own suspend) and is resuming.
      const { [CONTINUES_KEY]: _, ...rest } = previous as Record<string, unknown>;
      invocation.suspendPayload = rest;
      const requestId = verdict.requestId;
      this.#track(invocation, requestId, identity, (status) =>
        this.gate.client.reportOutcome(requestId, status).catch((err: unknown) => this.#logger.warn(`could not report the outcome of ${requestId}`, err)),
      );
      return;
    }
    if (paused !== undefined) {
      // Resumed from this integration's pause: the tool starts fresh.
      invocation.resumeData = undefined;
      delete invocation.suspendPayload;
    }
    this.#track(invocation, verdict.requestId, identity, (status) => verdict.report(status));
  }

  #track(invocation: Invocation, requestId: string, identity: Identity, report: Running["report"]): void {
    const running: Running = { report, suspended: false };
    this.#running.set(invocation, running);
    const suspend = invocation.suspend;
    if (typeof suspend !== "function") return;
    invocation.suspend = (payload, options) => {
      running.suspended = true;
      // A payload that is not an object cannot carry the marker, so the call will be refused on resume.
      const marked = payload === undefined || isRecord(payload) ? { ...payload, [CONTINUES_KEY]: markerPayload(requestId, identity) } : payload;
      return suspend(marked, options);
    };
  }

  async #after(hook: ToolAfterHookContext): Promise<void> {
    if (!isRecord(hook.context)) return;
    const running = this.#running.get(hook.context);
    this.#running.delete(hook.context);
    if (running === undefined || running.suspended || !this.gate.reportOutcomes) return;
    const output = hook.output;
    const failed = hook.error !== undefined || (isRecord(output) && output.error === true);
    await running.report(failed ? "failed" : "succeeded");
  }

  /**
   * Confirm that every tool call of an agent and its sub-agents reaches the
   * provider. Throws an error that lists each gap: an agent without these
   * hooks, hooks that replace them in the agent's default options, a
   * sub-agent that is not a Mastra `Agent`, and tools without an `execute`
   * (provider-run and client tools), which never reach the hook.
   */
  async check(agent: Agent, options: { requestContext?: RequestContext } = {}): Promise<void> {
    const problems: string[] = [];
    const seen = new Set<unknown>();
    const visit = async (current: unknown, path: string): Promise<void> => {
      if (seen.has(current)) return;
      seen.add(current);
      const candidate = current as Partial<Agent>;
      if (typeof candidate.getConfiguredToolHooks !== "function" || typeof candidate.listTools !== "function") {
        problems.push(`${path} is not a Mastra Agent, so its tool calls cannot be gated here`);
        return;
      }
      const target = candidate as Agent;
      const configured = target.getConfiguredToolHooks();
      if (configured?.beforeToolCall !== this.hooks.beforeToolCall || configured?.afterToolCall !== this.hooks.afterToolCall) {
        problems.push(`${path} does not use these approval hooks`);
      }
      const hooks = (await target.getDefaultOptions({ requestContext: options.requestContext }))?.hooks;
      if ((hooks?.beforeToolCall && hooks.beforeToolCall !== this.hooks.beforeToolCall) || (hooks?.afterToolCall && hooks.afterToolCall !== this.hooks.afterToolCall)) {
        problems.push(`${path} replaces the approval hooks in its default options`);
      }
      for (const [name, tool] of Object.entries(await target.listTools({ requestContext: options.requestContext }))) {
        if (typeof (tool as { execute?: unknown }).execute !== "function") problems.push(`${path} tool ${name} has no execute, so it runs outside Mastra and is never gated`);
      }
      for (const [name, sub] of Object.entries(await target.listAgents({ requestContext: options.requestContext }))) {
        await visit(sub, `${path} sub-agent ${name}`);
      }
    };
    await visit(agent, `agent ${agent.id}`);
    if (problems.length > 0) throw new Error(`Some tool calls would not be gated:\n- ${problems.join("\n- ")}`);
  }
}

/** Where a paused tool call waits: a top-level run and the tool call inside it to resume. */
export interface WaitingRun {
  agent: Agent;
  runId: string;
  toolCallId: string;
}

/**
 * The request a suspended tool call waits on. A sub-agent's pause reaches
 * its parent as, or wrapped in, the sub-agent's own suspend payload.
 */
function waitsOn(payload: unknown, depth = 0): string | undefined {
  if (!isRecord(payload) || depth > 8) return undefined;
  return marker(payload)?.requestId ?? waitsOn(payload.suspendPayload, depth + 1);
}

async function waiting(agents: readonly Agent[], requestId: string): Promise<WaitingRun | undefined> {
  for (const agent of agents) {
    const { runs } = await agent.listSuspendedRuns();
    for (const run of runs) {
      for (const call of run.toolCalls) {
        if (call.toolCallId && waitsOn(call.suspendPayload) === requestId) return { agent, runId: run.runId, toolCallId: call.toolCallId };
      }
    }
  }
  return undefined;
}

export interface ResumerOptions {
  /** Options for each resumed run, such as `memory` or `requestContext`. */
  options?: Record<string, unknown>;
  /** Called with each resumed run's output once it has finished. Without memory, this is the only place it appears. */
  onResult?: (output: Awaited<ReturnType<Agent["resumeStream"]>>, run: WaitingRun) => void | Promise<void>;
}

/**
 * A `Receiver` resumer for agents running in this process.
 *
 * Pass the agents you start runs on. A call in a sub-agent waits inside its
 * parent's run, so pass the parent, not the sub-agent. The resumer finds the
 * suspended run waiting on the decided request and resumes only that tool
 * call, one resume per run at a time.
 */
export function resumer(agents: Agent | readonly Agent[], options: ResumerOptions = {}): Resumer {
  const list: readonly Agent[] = Array.isArray(agents) ? agents : [agents as Agent];
  const locks = new Map<string, Promise<void>>();
  return async (_handle: JsonObject, request: ApprovalRequest) => {
    const found = await waiting(list, request.id);
    if (found === undefined) return;
    const key = `${found.agent.id}:${found.runId}`;
    const run = (locks.get(key) ?? Promise.resolve()).then(async () => {
      const still = await waiting([found.agent], request.id); // the run may have moved on while waiting for the lock
      if (still === undefined || still.runId !== found.runId) return;
      const output = await still.agent.resumeStream({}, { ...options.options, runId: still.runId, toolCallId: still.toolCallId });
      await output.consumeStream();
      if (output.error) throw output.error;
      await options.onResult?.(output, still);
    });
    const settled = run.catch(() => {});
    locks.set(key, settled);
    void settled.finally(() => {
      if (locks.get(key) === settled) locks.delete(key);
    });
    await run;
  };
}
