/**
 * Webhook receiver for asynchronous mode.
 *
 * The receiver verifies AAP webhooks, answers receiver verification during
 * provisioning, and wakes paused runs. A notification only wakes a run: the
 * gate fetches and consumes the decision itself, so the receiver keeps no
 * state and a repeated or forged event at most wakes a run that pauses again.
 *
 * The resume handle is read from the request's `context.resume`, which the
 * gate wrote when it created the request. Its `framework` names the resumer
 * to call.
 */

import { AAPError, type Client } from "./client.js";
import type { Logger } from "./gate.js";
import { type ApprovalRequest, type JsonObject, ProtocolError, isRawObject, loads, plain } from "./wire.js";

/** Resumes a paused run from its resume handle. */
export type Resumer = (handle: JsonObject, request: ApprovalRequest) => void | Promise<void>;

/** A webhook delivery failed verification. */
export class WebhookError extends Error {
  override name = "WebhookError";
}

export type HeadersInput = Headers | Record<string, string | string[] | undefined>;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function signingKey(secret: string): Uint8Array {
  if (!secret.startsWith("whsec_")) throw new TypeError("signing secret must start with whsec_");
  const encoded = secret.slice("whsec_".length);
  if (!BASE64.test(encoded)) throw new TypeError("signing secret is not valid base64");
  const key = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  if (key.length === 0) throw new TypeError("signing secret is empty");
  return key;
}

function bytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/** The `webhook-signature` header value for one delivery attempt. */
export async function sign(secret: string, messageId: string, timestamp: number, body: Uint8Array | string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", signingKey(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = new TextEncoder().encode(`${messageId}.${timestamp}.`);
  const content = bytes(body);
  const message = new Uint8Array(prefix.length + content.length);
  message.set(prefix);
  message.set(content, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return "v1," + btoa(String.fromCharCode(...digest));
}

function header(headers: HeadersInput, name: string): string {
  if (headers instanceof Headers) return headers.get(name) ?? "";
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value.join(" ") : (value ?? "");
  }
  return "";
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface VerifyOptions {
  /** Seconds a delivery's timestamp may differ from now. Default 300. */
  tolerance?: number;
  /** The current time in Unix seconds. */
  now?: number;
}

/** Verify a delivery and return its parsed body. Throws `WebhookError`. */
export async function verify(secret: string, headers: HeadersInput, body: Uint8Array | string, options: VerifyOptions = {}): Promise<JsonObject> {
  const messageId = header(headers, "webhook-id");
  const stamp = header(headers, "webhook-timestamp");
  const signatures = header(headers, "webhook-signature").split(/\s+/).filter(Boolean);
  if (!messageId || !/^\d+$/.test(stamp) || signatures.length === 0) throw new WebhookError("missing webhook headers");
  const now = options.now ?? Date.now() / 1000;
  if (Math.abs(now - Number(stamp)) > (options.tolerance ?? 300)) throw new WebhookError("webhook timestamp outside tolerance");
  const content = bytes(body);
  const expected = await sign(secret, messageId, Number(stamp), content);
  if (!signatures.some((candidate) => candidate.startsWith("v1,") && equal(expected, candidate))) {
    throw new WebhookError("invalid webhook signature");
  }
  let message;
  try {
    message = loads(content);
  } catch {
    throw new WebhookError("invalid webhook body");
  }
  if (!isRawObject(message) || message.id !== messageId) throw new WebhookError("webhook ID does not match the body");
  return plain(message) as JsonObject;
}

export interface ReceiverOptions {
  secret: string;
  client: Client;
  /** Maps a framework name to a function that resumes a run from its resume handle. */
  resumers: Record<string, Resumer> | Map<string, Resumer>;
  /** The ID the provisioner generated for this receiver; verification for any other registration is refused. */
  registrationId?: string;
  /** Once known, restricts notifications to that instance. */
  instanceId?: string;
  /** Seconds a delivery's timestamp may differ from now. Default 300. */
  tolerance?: number;
  logger?: Logger;
  /** Keeps the background wake alive after the response, e.g. a Workers `ctx.waitUntil` or Next.js `after`. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface Reply {
  status: number;
  body: string;
}

/** Verifies AAP webhooks and wakes paused runs. */
export class Receiver {
  readonly client: Client;
  readonly registrationId?: string;
  readonly instanceId?: string;
  readonly tolerance: number;
  readonly #secret: string;
  readonly #resumers: Map<string, Resumer>;
  readonly #logger: Logger;
  readonly #waitUntil?: (promise: Promise<unknown>) => void;
  readonly #tasks = new Set<Promise<void>>();

  constructor(options: ReceiverOptions) {
    signingKey(options.secret);
    this.#secret = options.secret;
    this.client = options.client;
    this.#resumers = new Map(options.resumers instanceof Map ? options.resumers : Object.entries(options.resumers));
    this.registrationId = options.registrationId;
    this.instanceId = options.instanceId;
    this.tolerance = options.tolerance ?? 300;
    this.#logger = options.logger ?? console;
    this.#waitUntil = options.waitUntil;
  }

  /**
   * Process one delivery and return the HTTP status and body to send.
   *
   * A notification is acknowledged at once and the run is woken in the
   * background, because a delivery attempt has a ten second limit.
   */
  async handle(headers: HeadersInput, body: Uint8Array | string): Promise<Reply> {
    let message: JsonObject;
    try {
      message = await verify(this.#secret, headers, body, { tolerance: this.tolerance });
    } catch (err) {
      if (err instanceof WebhookError) return { status: 401, body: "" };
      throw err;
    }
    if (message.type === "webhook.verification") {
      if (this.registrationId === undefined || message.registration_id !== this.registrationId || typeof message.challenge !== "string") {
        return { status: 403, body: "" };
      }
      return { status: 200, body: JSON.stringify({ challenge: message.challenge }) };
    }
    if (message.type === "request.resolved") {
      if (this.instanceId !== undefined && message.instance_id !== this.instanceId) return { status: 403, body: "" };
      const requestId = message.request_id;
      if (typeof requestId === "string") {
        const task = this.wake(requestId).then(
          () => {},
          (err) => this.#logger.error(`resuming the run for request ${requestId} failed`, err),
        );
        this.#tasks.add(task);
        void task.finally(() => this.#tasks.delete(task));
        this.#waitUntil?.(task);
      }
      return { status: 204, body: "" };
    }
    return { status: 400, body: "" };
  }

  /** Resume the run waiting on a request. Also the recovery sweep's entry point. */
  async wake(requestId: string): Promise<boolean> {
    let request: ApprovalRequest;
    try {
      request = await this.client.get(requestId);
    } catch (err) {
      if (!(err instanceof AAPError || err instanceof ProtocolError)) throw err;
      this.#logger.warn(`could not read request ${requestId} to resume it`, err);
      return false;
    }
    const handle = request.context?.resume;
    const framework = typeof handle === "object" && handle !== null && !Array.isArray(handle) ? handle.framework : undefined;
    const resumer = typeof framework === "string" ? this.#resumers.get(framework) : undefined;
    if (resumer === undefined) {
      this.#logger.warn(`request ${requestId} has no resume handle this receiver can use`);
      return false;
    }
    try {
      await resumer(handle as JsonObject, request);
      return true;
    } catch (err) {
      this.#logger.error(`resuming the run for request ${requestId} failed`, err);
      return false;
    }
  }

  /**
   * A Web-standard handler that accepts POSTed webhooks at any path it is
   * mounted on: Next.js route handlers, Hono, Bun, Deno and Workers.
   */
  readonly handler = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const reply = await this.handle(request.headers, new Uint8Array(await request.arrayBuffer()));
    return new Response(reply.body || null, {
      status: reply.status,
      headers: reply.body ? { "content-type": "application/json" } : {},
    });
  };
}
