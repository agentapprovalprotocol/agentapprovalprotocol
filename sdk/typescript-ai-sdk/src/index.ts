/**
 * Approvals for Vercel AI SDK agents.
 *
 * `approvals` installs on the AI SDK's `toolApproval` check, so every tool
 * call the model makes goes to an AAP provider before it runs, including
 * dynamic MCP tools. In sync mode the call waits for the decision. In async
 * mode the run ends with the AI SDK's own `tool-approval-request`, and a
 * `Receiver` resumes the thread from your message store when the decision
 * arrives.
 *
 * Approval responses in the message history are never trusted. When a run
 * continues with them, the AI SDK asks `toolApproval` again, and the gate
 * asks the provider: the call runs only if the provider approved it and the
 * approval is consumed now. Every other answer, including "still pending",
 * is a denial, because the AI SDK runs a replayed call unless it is denied.
 */

import type { Call, Gate, JsonObject, Resumer } from "@agentapprovalprotocol/sdk";
import type { ModelMessage, Tool, ToolApprovalStatus, ToolExecutionEndEvent, ToolExecutionOptions, ToolSet } from "ai";

export const FRAMEWORK = "ai-sdk";

export const FAIL_CLOSED = "The approval adapter could not obtain a valid AAP decision. The call was not run.";
export const STILL_PENDING = "This call is still waiting for approval, so it was not run.";
export const NOT_AN_OBJECT = "Tool input must be a JSON object to be sent for approval. The call was not run.";

/** What identifies a run's thread: a fixed ID, or a function of the call's runtime context. */
export type ThreadId = string | ((runtimeContext: unknown) => string | undefined);

export interface ApprovalsOptions {
  gate: Gate;
  /**
   * The thread the run belongs to. It must stay the same when the thread is
   * continued after a pause. Default: `runtimeContext.threadId`. Without a
   * thread ID, calls wait instead of pausing.
   */
  threadId?: ThreadId;
  /** Context sent with every request. */
  context?: Record<string, unknown>;
}

interface ApprovalOptions {
  toolCall: { toolCallId: string; toolName: string; input: unknown; providerExecuted?: boolean };
  tools: ToolSet | undefined;
  runtimeContext: unknown;
  messages: ModelMessage[];
}

/** Spread into `generateText`, `streamText` or `new ToolLoopAgent(...)`. */
export interface Approvals {
  toolApproval: (options: ApprovalOptions) => Promise<ToolApprovalStatus>;
  /** Reports each approved call's outcome to the provider. */
  onToolExecutionEnd: (event: ToolExecutionEndEvent) => Promise<void>;
}

/** The tool set contains a tool that cannot wait for approval. */
export class UngatedToolError extends Error {
  override name = "UngatedToolError";
}

/** Thrown by a gated tool's `execute` when the call must not run. `message` is written for the model. */
export class ApprovalDenied extends Error {
  override name = "ApprovalDenied";
  constructor(
    readonly reason: string,
    readonly status: string,
  ) {
    super(reason);
  }
}

const gatedExecutes = new WeakSet<object>();

function isProviderExecuted(tool: Tool | undefined): boolean {
  return tool?.type === "provider" && (tool as { isProviderExecuted?: boolean }).isProviderExecuted === true;
}

function refuseProviderTools(tools: ToolSet | undefined): void {
  for (const [name, tool] of Object.entries(tools ?? {})) {
    if (isProviderExecuted(tool)) {
      throw new UngatedToolError(`Tool "${name}" runs at the model provider, so it cannot wait for approval. Remove it from the agent's tools.`);
    }
  }
}

function resolveThread(threadId: ThreadId | undefined, runtimeContext: unknown): string | undefined {
  if (typeof threadId === "string") return threadId;
  if (typeof threadId === "function") return threadId(runtimeContext);
  const value = (runtimeContext as { threadId?: unknown } | null | undefined)?.threadId;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callFor(
  toolCall: { toolCallId: string; toolName: string; input: unknown },
  thread: string | undefined,
  context: Record<string, unknown>,
): Call | undefined {
  if (!isObject(toolCall.input)) return undefined;
  const call: Call = {
    key: `${thread ?? "-"}:${toolCall.toolCallId}`,
    tool: toolCall.toolName,
    arguments: toolCall.input,
    context,
  };
  if (thread !== undefined) call.resume = { framework: FRAMEWORK, thread_id: thread, tool_call_id: toolCall.toolCallId };
  return call;
}

/**
 * Whether the run is continuing a paused call. A new call's own assistant
 * message is not in `messages`; a replayed call's approval request is.
 */
function isReplay(messages: ModelMessage[], toolCallId: string): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "tool-approval-request" && part.toolCallId === toolCallId),
  );
}

/**
 * Send every tool call to an AAP provider before it runs.
 *
 * Spread the result into `generateText`, `streamText` or a `ToolLoopAgent`'s
 * settings. It replaces `onToolExecutionEnd`; call `onToolExecutionEnd`
 * from yours if you have one. Tools wrapped with `gatedTools` are left to
 * their own gate.
 */
export function approvals(options: ApprovalsOptions): Approvals {
  const { gate, threadId } = options;
  const context = { framework: FRAMEWORK, ...(options.context ?? {}) };
  // Approved calls waiting to run, by the AI SDK's tool call object.
  const allowed = new WeakMap<object, { report: (status: "succeeded" | "failed") => Promise<boolean> }>();

  const toolApproval = async ({ toolCall, tools, runtimeContext, messages }: ApprovalOptions): Promise<ToolApprovalStatus> => {
    refuseProviderTools(tools);
    if (toolCall.providerExecuted) throw new UngatedToolError(`Tool "${toolCall.toolName}" ran at the model provider, so it could not wait for approval.`);
    const tool = tools !== undefined && Object.hasOwn(tools, toolCall.toolName) ? tools[toolCall.toolName] : undefined; // the name comes from the model
    if (tool?.execute !== undefined && gatedExecutes.has(tool.execute)) return "not-applicable";
    const replay = isReplay(messages, toolCall.toolCallId);
    try {
      const thread = resolveThread(threadId, runtimeContext);
      const call = callFor(toolCall, thread, context);
      if (call === undefined) return { type: "denied", reason: NOT_AN_OBJECT };
      const verdict = await gate.check(call, { canPause: thread !== undefined });
      if (verdict.kind === "allow") {
        allowed.set(toolCall, verdict);
        return "approved";
      }
      if (verdict.kind === "deny") return { type: "denied", reason: verdict.reason };
      // A paused call is continued only by a decision. On replay, anything
      // but a denial would run the call, so a pending call is denied there.
      return replay ? { type: "denied", reason: STILL_PENDING } : "user-approval";
    } catch {
      return { type: "denied", reason: FAIL_CLOSED };
    }
  };

  const onToolExecutionEnd = async (event: ToolExecutionEndEvent): Promise<void> => {
    const allow = allowed.get(event.toolCall);
    if (allow === undefined) return;
    allowed.delete(event.toolCall);
    if (gate.reportOutcomes) await allow.report(event.toolOutput.type === "tool-error" ? "failed" : "succeeded");
  };

  return { toolApproval, onToolExecutionEnd };
}

export interface GatedToolsOptions {
  gate: Gate;
  /** A thread ID that keeps call keys unique across runs. Default none. */
  threadId?: string;
  context?: Record<string, unknown>;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value != null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
}

function isAsyncGeneratorFunction(fn: unknown): boolean {
  return Object.prototype.toString.call(fn) === "[object AsyncGeneratorFunction]";
}

/**
 * Tools whose `execute` waits for approval before it runs.
 *
 * Use them where `toolApproval` does not reach: inside sub-agents, which
 * cannot pause, and for tools other tools call. Calls always wait, even
 * with an async gate. A denied call throws `ApprovalDenied`, which the
 * model sees as a tool error.
 */
export function gatedTools<TOOLS extends ToolSet>(tools: TOOLS, options: GatedToolsOptions): TOOLS {
  const { gate, threadId } = options;
  const context = { framework: FRAMEWORK, ...(options.context ?? {}) };
  const out: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (isProviderExecuted(tool)) throw new UngatedToolError(`Tool "${name}" runs at the model provider, so it cannot wait for approval.`);
    const execute = tool.execute as ((input: unknown, options: ToolExecutionOptions<unknown>) => unknown) | undefined;
    if (execute === undefined) throw new UngatedToolError(`Tool "${name}" has no execute function to gate.`);
    if (gatedExecutes.has(execute)) {
      out[name] = tool;
      continue;
    }

    const check = async (input: unknown, execOptions: ToolExecutionOptions<unknown>) => {
      const call = callFor({ toolCallId: execOptions.toolCallId, toolName: name, input }, threadId, context);
      if (call === undefined) throw new ApprovalDenied(NOT_AN_OBJECT, "error");
      delete call.resume; // gated tools cannot pause
      const verdict = await gate.check(call, { canPause: false });
      if (verdict.kind === "allow") return verdict;
      throw new ApprovalDenied(verdict.kind === "deny" ? verdict.reason : FAIL_CLOSED, verdict.kind === "deny" ? verdict.status : "error");
    };
    const report = async (allow: { report: (status: "succeeded" | "failed") => Promise<boolean> }, status: "succeeded" | "failed") => {
      if (gate.reportOutcomes) await allow.report(status);
    };

    const wrapped = isAsyncGeneratorFunction(execute)
      ? async function* (input: unknown, execOptions: ToolExecutionOptions<unknown>) {
          const allow = await check(input, execOptions);
          try {
            yield* execute(input, execOptions) as AsyncIterable<unknown>;
          } catch (err) {
            await report(allow, "failed");
            throw err;
          }
          await report(allow, "succeeded");
        }
      : async (input: unknown, execOptions: ToolExecutionOptions<unknown>) => {
          const allow = await check(input, execOptions);
          let result: unknown;
          try {
            result = await execute(input, execOptions);
            if (isAsyncIterable(result)) {
              let last: unknown;
              for await (const value of result) last = value;
              result = last;
            }
          } catch (err) {
            await report(allow, "failed");
            throw err;
          }
          await report(allow, "succeeded");
          return result;
        };
    gatedExecutes.add(wrapped);
    out[name] = { ...tool, execute: wrapped } as Tool;
  }
  return out as TOOLS;
}

export interface ResumerOptions {
  /** The thread's stored messages, or undefined if there is no such thread. */
  load: (threadId: string) => ModelMessage[] | undefined | Promise<ModelMessage[] | undefined>;
  /** Store the thread's messages. */
  save: (threadId: string, messages: ModelMessage[]) => unknown;
  /** Continue the thread with these messages and store the result. */
  run: (threadId: string, messages: ModelMessage[]) => unknown;
}

type Part = { type: string; approvalId?: string; toolCallId?: string; isAutomatic?: boolean };

function parts(message: ModelMessage | undefined): Part[] {
  return message !== undefined && Array.isArray(message.content) ? (message.content as Part[]) : [];
}

/**
 * A `Receiver` resumer for threads whose messages you store.
 *
 * When a paused call is decided, it adds a `tool-approval-response` for
 * that call to the thread and saves it. Once every paused call in the step
 * has one, it calls `run` to continue the thread. The response only asks
 * the gate to check again: a denied call is denied then. One resume per
 * thread runs at a time in this process.
 */
export function resumer(options: ResumerOptions): Resumer {
  const locks = new Map<string, Promise<void>>();

  const resume = async (thread: string, toolCallId: string): Promise<void> => {
    const stored = await options.load(thread);
    if (stored === undefined) return;
    const messages = [...stored];
    const step = messages.findLastIndex((message) => message.role === "assistant");
    if (step < 0) return;
    const tail = messages.slice(step + 1);
    if (tail.some((message) => message.role !== "tool")) return;
    const requests = parts(messages[step]).filter((part) => part.type === "tool-approval-request" && !part.isAutomatic);
    const answered = new Set(tail.flatMap(parts).filter((part) => part.type === "tool-approval-response").map((part) => part.approvalId));
    const finished = new Set(tail.flatMap(parts).filter((part) => part.type === "tool-result").map((part) => part.toolCallId));
    const open = (part: Part) => !answered.has(part.approvalId) && !finished.has(part.toolCallId);

    const target = requests.find((part) => part.toolCallId === toolCallId && open(part));
    if (target !== undefined) {
      const response = { type: "tool-approval-response" as const, approvalId: target.approvalId!, approved: true };
      const last = messages.at(-1);
      if (step < messages.length - 1 && last?.role === "tool") {
        messages[messages.length - 1] = { ...last, content: [...last.content, response] };
      } else {
        messages.push({ role: "tool", content: [response] });
      }
      answered.add(target.approvalId);
      await options.save(thread, messages);
    }
    const ready = requests.some((part) => answered.has(part.approvalId) && !finished.has(part.toolCallId));
    if (ready && !requests.some(open)) await options.run(thread, messages);
  };

  return async (handle: JsonObject, request) => {
    const thread = handle.thread_id;
    const toolCallId = handle.tool_call_id;
    if (typeof thread !== "string" || typeof toolCallId !== "string" || request.status === "pending") return;
    const previous = locks.get(thread) ?? Promise.resolve();
    const current = previous.then(() => resume(thread, toolCallId));
    const settled = current.catch(() => {});
    locks.set(thread, settled);
    try {
      await current;
    } finally {
      if (locks.get(thread) === settled) locks.delete(thread);
    }
  };
}
