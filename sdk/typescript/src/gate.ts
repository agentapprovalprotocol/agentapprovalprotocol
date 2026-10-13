/**
 * The gate: whether one tool call may run now.
 *
 * Every check runs the same steps, whether the call is new or seen again
 * after a resume: create the request with the call's idempotency key (a
 * replay returns the existing request), wait or report pending, check the
 * decision, consume it, allow. A value a framework passes back on resume is
 * never read, so only the provider can approve. Any failure denies.
 */

import { AAPError, type Client, ConflictError, CredentialRefused, type Submission } from "./client.js";
import {
  APPROVED,
  type ApprovalRequest,
  CANCELLED,
  DENIED,
  EXPIRED,
  type OutcomeStatus,
  PENDING,
  ProtocolError,
  type RawObject,
  dumps,
  exactOf,
  loads,
  matches,
  nowMicros,
} from "./wire.js";

export const FAIL_CLOSED = "The approval adapter could not obtain a valid AAP decision. The call was not run.";
export const REFUSED =
  "The approval provider refused this agent's credential, so no tool call can run. Ask whoever manages the agent. The call was not run.";
export const EXPIRED_TEXT = "The approval window or permission to start this call expired. The call was not run.";
export const CANCELLED_TEXT = "The call was cancelled before execution.";
export const CONSUMED_TEXT =
  "This approved call was already attempted, so it was not run again. Request approval again if it still needs to happen.";
export const TIMED_OUT = "Approval was not obtained in time. The call was not run.";

export type Mode = "sync" | "async";

/** Where the gate and receiver log. Defaults to `console`. */
export interface Logger {
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

/**
 * One tool call the gate is asked about.
 *
 * `key` must identify this tool call within its run and stay the same when
 * the call is seen again after a resume or replay. `resume` is how a
 * receiver wakes the run later, in async mode.
 */
export interface Call {
  key: string;
  tool: string;
  arguments: Record<string, unknown>;
  server?: string;
  reasoning?: string;
  context?: Record<string, unknown>;
  resume?: Record<string, unknown>;
}

/** The approval was checked and consumed. Run the tool now. */
export interface Allow {
  kind: "allow";
  requestId: string;
  /** Report the outcome. Best effort: failures are logged, never thrown. */
  report(status: OutcomeStatus, note?: string): Promise<boolean>;
}

/** The call must not run. `reason` is written for the model. */
export interface Deny {
  kind: "deny";
  reason: string;
  status: "denied" | "cancelled" | "expired" | "consumed" | "error";
  requestId?: string;
}

/** Async mode: no decision yet. Pause the run; a receiver wakes it. */
export interface Pending {
  kind: "pending";
  requestId: string;
}

export type Verdict = Allow | Deny | Pending;

/** What `guard` returns: the tool's value when it ran, otherwise the verdict. */
export type Guarded<T> = { kind: "allow"; requestId: string; value: T } | Deny | Pending;

export interface GateOptions {
  /** `sync` waits for each decision. `async` returns `Pending` instead. Default `sync`. */
  mode?: Mode;
  /** The request timeout sent to the provider. Default `10m`, or `24h` in async mode. */
  timeout?: string;
  /** Seconds to wait for a decision before cancelling and denying. Default 540. */
  waitLimit?: number;
  /** Context sent with every request. */
  context?: Record<string, unknown>;
  /** Whether `guard` reports outcomes. Default true. */
  reportOutcomes?: boolean;
  logger?: Logger;
}

export interface CheckOptions {
  /** False when this call cannot be paused, so async mode waits for it. Default true. */
  canPause?: boolean;
}

export function submission(call: Call, timeout: string, defaults: Record<string, unknown>): Submission {
  const context: Record<string, unknown> = { ...defaults, ...(call.context ?? {}), call_id: call.key };
  if (call.resume != null) context.resume = { ...call.resume };
  const body: Submission = { tool: call.tool, arguments: { ...call.arguments }, timeout, context };
  if (call.server) body.server = call.server;
  if (call.reasoning) body.agent_reasoning = call.reasoning;
  return body;
}

/** Stable for the same call and submission; any change asks again. The same key as the Python SDK's. */
export async function idempotencyKey(call: Call, body: Submission): Promise<string> {
  const key = new TextEncoder().encode(call.key);
  const content = new TextEncoder().encode(dumps(body));
  const message = new Uint8Array(key.length + 1 + content.length);
  message.set(key);
  message.set(content, key.length + 1);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", message));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function settled(request: ApprovalRequest): Deny | undefined {
  if (request.status === DENIED) {
    const note = request.decision?.note;
    return deny(note ? `Approval for this call was denied, so it was not run. Reason: ${note}` : "Approval for this call was denied, so it was not run.", DENIED, request.id);
  }
  if (request.status === CANCELLED) return deny(CANCELLED_TEXT, CANCELLED, request.id);
  if (request.status === EXPIRED) return deny(EXPIRED_TEXT, EXPIRED, request.id);
  const expires = exactOf(request).expiresAt;
  if (request.status !== APPROVED || expires === undefined) throw new ProtocolError("invalid decision");
  if (request.consumption !== undefined) return deny(CONSUMED_TEXT, "consumed", request.id);
  if (nowMicros() >= expires) return deny(EXPIRED_TEXT, EXPIRED, request.id);
  return undefined;
}

function deny(reason: string, status: Deny["status"], requestId?: string): Deny {
  return requestId === undefined ? { kind: "deny", reason, status } : { kind: "deny", reason, status, requestId };
}

function conflict(err: ConflictError, requestId: string): Deny {
  if (err.code === "already_consumed") return deny(CONSUMED_TEXT, "consumed", requestId);
  if (err.code === "approval_expired") return deny(EXPIRED_TEXT, EXPIRED, requestId);
  return deny(FAIL_CLOSED, "error", requestId);
}

const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
const monotonic = () => performance.now() / 1000;

/**
 * Decides whether one tool call may run.
 *
 * In sync mode `check` waits for the decision. In async mode it returns
 * `Pending` when there is none yet, unless the caller says this call cannot
 * be paused, in which case it waits.
 */
export class Gate {
  readonly mode: Mode;
  readonly timeout: string;
  readonly waitLimit: number;
  readonly context: Record<string, unknown>;
  readonly reportOutcomes: boolean;
  readonly #logger: Logger;

  constructor(
    readonly client: Client,
    options: GateOptions = {},
  ) {
    const mode = options.mode ?? "sync";
    if (mode !== "sync" && mode !== "async") throw new TypeError("mode must be sync or async");
    this.mode = mode;
    this.timeout = options.timeout || (mode === "async" ? "24h" : "10m");
    this.waitLimit = options.waitLimit ?? 540;
    this.context = { ...(options.context ?? {}) };
    this.reportOutcomes = options.reportOutcomes ?? true;
    this.#logger = options.logger ?? console;
  }

  async check(call: Call, options: CheckOptions = {}): Promise<Verdict> {
    const canPause = options.canPause ?? true;
    let request: ApprovalRequest | undefined;
    try {
      const body = submission(call, this.timeout, this.context);
      const sent = loads(dumps(body)) as RawObject; // compare responses with what was sent, exactly
      request = await this.client.create(body, await idempotencyKey(call, body));
      if (!matches(request, sent)) throw new ProtocolError("the provider returned a different request");
      const started = monotonic();
      while (request.status === PENDING) {
        if (this.mode === "async" && canPause) return { kind: "pending", requestId: request.id };
        const left = this.#pollUntil(request, started) - monotonic();
        if (left <= 0) {
          await this.client.cancel(request.id).catch(() => {});
          return deny(TIMED_OUT, EXPIRED, request.id);
        }
        const previous: ApprovalRequest = request;
        const polled = monotonic();
        request = await this.client.get(request.id, { wait: Math.max(1, Math.min(25, Math.trunc(left))) });
        if (!matches(request, sent, previous)) throw new ProtocolError("the provider returned a different request");
        if (request.status === PENDING && monotonic() - polled < 0.1) await sleep(0.1); // the provider answered without waiting
      }
      const denied = settled(request);
      if (denied) return denied;
      let consumed: ApprovalRequest;
      try {
        consumed = await this.client.consume(request.id, crypto.randomUUID());
      } catch (err) {
        if (err instanceof ConflictError) return conflict(err, request.id);
        throw err;
      }
      if (!(consumed.status === APPROVED && consumed.consumption !== undefined && matches(consumed, sent, request))) {
        throw new ProtocolError("invalid consumption");
      }
      const requestId = request.id;
      return { kind: "allow", requestId, report: (status, note) => this.#report(requestId, status, note) };
    } catch (err) {
      if (err instanceof CredentialRefused) return deny(REFUSED, "error", request?.id);
      if (!(err instanceof AAPError || err instanceof ProtocolError)) this.#logger.error("approval gate failed", err);
      return deny(FAIL_CLOSED, "error", request?.id);
    }
  }

  /** Check the call and run `fn` only on an allow, reporting whether it succeeded. */
  async guard<T>(call: Call, fn: (allow: Allow) => T | Promise<T>, options: CheckOptions = {}): Promise<Guarded<T>> {
    const verdict = await this.check(call, options);
    if (verdict.kind !== "allow") return verdict;
    let value: T;
    try {
      value = await fn(verdict);
    } catch (err) {
      if (this.reportOutcomes) await verdict.report("failed");
      throw err;
    }
    if (this.reportOutcomes) await verdict.report("succeeded");
    return { kind: "allow", requestId: verdict.requestId, value };
  }

  #pollUntil(request: ApprovalRequest, started: number): number {
    const remaining = (request.deadlineAt.getTime() - Date.now()) / 1000 + 10;
    return started + Math.min(this.waitLimit, Math.max(0, remaining));
  }

  async #report(requestId: string, status: OutcomeStatus, note?: string): Promise<boolean> {
    try {
      await this.client.reportOutcome(requestId, status, note);
      return true;
    } catch (err) {
      this.#logger.warn(`could not report the outcome of ${requestId}`, err);
      return false;
    }
  }
}
