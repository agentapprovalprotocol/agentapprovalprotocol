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
 *
 * Verification needs only the signing secret and the registration ID, so a
 * receiver can start before the instance exists. Waking a run needs a client
 * for the instance credential, which exists only after provisioning: pass a
 * client, a factory that builds one on first wake, or call `provision`.
 */

import { AAPError, Client, type Fetch, ProvisionError, USER_AGENT, WebhookVerificationFailed, read, validateBaseUrl } from "./client.js";
import type { Logger } from "./gate.js";
import { type ApprovalRequest, type JsonObject, ProtocolError, isRawObject, loads, plain } from "./wire.js";

/** Resumes a paused run from its resume handle. */
export type Resumer = (handle: JsonObject, request: ApprovalRequest) => void | Promise<void>;

/** Builds the client on first wake, for example from a credential saved after provisioning. */
export type ClientFactory = () => Client | Promise<Client>;

/** A fresh signing secret: 32 random bytes as padded base64 with a `whsec_` prefix. */
export function newSecret(): string {
  return "whsec_" + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

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
  /** The instance's signing secret. `provision` generates one if it is not given. */
  secret?: string;
  /**
   * Reads requests when a run is woken: a client, or a function returning one
   * that is called on first wake and then cached. Leave it out until
   * `provision` installs one.
   */
  client?: Client | ClientFactory;
  /** Maps a framework name to a function that resumes a run from its resume handle. */
  resumers: Record<string, Resumer> | Map<string, Resumer>;
  /**
   * The ID the provisioner generated for this receiver; verification for any
   * other registration is refused. `provision` generates one if it is not given.
   */
  registrationId?: string;
  /** Once known, restricts notifications to that instance. */
  instanceId?: string;
  /** Seconds a delivery's timestamp may differ from now. Default 300. */
  tolerance?: number;
  logger?: Logger;
  /** Keeps the background wake alive after the response, e.g. a Workers `ctx.waitUntil` or Next.js `after`. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface ProvisionOptions {
  /** The provider's AAP base URL. */
  providerUrl: string;
  provisionerToken: string;
  /** This receiver's public HTTPS URL. */
  url: string;
  instanceName?: string;
  /** Defaults to the registration ID, so calling again after a failure retries the same submission. */
  idempotencyKey?: string;
  /** The `fetch` implementation for provisioning and the installed client. Defaults to the global `fetch`. */
  fetch?: Fetch;
}

/** An instance created by `Receiver.provision`. */
export interface Provisioned {
  instanceId: string;
  instanceName: string;
  /** The instance credential. Save it as a secret. */
  token: string;
  /** When the credential expires, as the provider returned it. Absent if no expiry is scheduled. */
  expiresAt?: string;
  /** The signing secret. Save it for the receiver's next start. */
  secret: string;
  registrationId: string;
}

export interface Reply {
  status: number;
  body: string;
}

/** Verifies AAP webhooks and wakes paused runs. */
export class Receiver {
  readonly tolerance: number;
  #secret?: string;
  #client?: Client;
  #factory?: ClientFactory;
  #loading?: Promise<Client>;
  #registrationId?: string;
  #instanceId?: string;
  readonly #resumers: Map<string, Resumer>;
  readonly #logger: Logger;
  readonly #waitUntil?: (promise: Promise<unknown>) => void;
  readonly #tasks = new Set<Promise<void>>();

  constructor(options: ReceiverOptions) {
    if (options.secret !== undefined) signingKey(options.secret);
    const client = options.client;
    this.#secret = options.secret;
    if (typeof client === "function") this.#factory = client;
    else this.#client = client;
    this.#resumers = new Map(options.resumers instanceof Map ? options.resumers : Object.entries(options.resumers));
    this.#registrationId = options.registrationId;
    this.#instanceId = options.instanceId;
    this.tolerance = options.tolerance ?? 300;
    this.#logger = options.logger ?? console;
    this.#waitUntil = options.waitUntil;
  }

  /** The client that reads requests on wake, once it exists. */
  get client(): Client | undefined {
    return this.#client;
  }

  get registrationId(): string | undefined {
    return this.#registrationId;
  }

  get instanceId(): string | undefined {
    return this.#instanceId;
  }

  /**
   * Process one delivery and return the HTTP status and body to send.
   *
   * A notification is acknowledged at once and the run is woken in the
   * background, because a delivery attempt has a ten second limit.
   */
  async handle(headers: HeadersInput, body: Uint8Array | string): Promise<Reply> {
    if (this.#secret === undefined) return { status: 401, body: "" };
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

  /**
   * Resume the run waiting on a request. Also the recovery sweep's entry point.
   *
   * Returns false when nothing was resumed, including when the receiver has
   * no client yet.
   */
  async wake(requestId: string): Promise<boolean> {
    let client: Client | undefined;
    try {
      client = await this.#resolveClient();
    } catch (err) {
      this.#logger.error(`could not create a client to resume request ${requestId}`, err);
      return false;
    }
    if (client === undefined) {
      this.#logger.warn(`cannot resume request ${requestId}: the receiver has no client yet`);
      return false;
    }
    let request: ApprovalRequest;
    try {
      request = await client.get(requestId);
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

  /** The client, building it with the factory once if needed. */
  async #resolveClient(): Promise<Client | undefined> {
    if (this.#client !== undefined || this.#factory === undefined) return this.#client;
    const factory = this.#factory;
    this.#loading ??= (async () => factory())();
    const loading = this.#loading;
    let client: Client;
    try {
      client = await loading;
    } catch (err) {
      if (this.#loading === loading) this.#loading = undefined;
      throw err;
    }
    this.#client ??= client;
    return this.#client;
  }

  /**
   * Create an instance whose notifications come to this receiver.
   *
   * The provider verifies the receiver before it answers, so the receiver
   * must already be serving at `url`. Generates the signing secret and
   * registration ID if the receiver has none. On success the receiver uses
   * the new credential to wake runs and accepts notifications only for the
   * new instance. Save the result: nothing is stored.
   *
   * Throws `WebhookVerificationFailed` when the provider could not verify the
   * receiver, `ProvisionError` for other failures and `ProtocolError` for a
   * malformed answer.
   */
  async provision(options: ProvisionOptions): Promise<Provisioned> {
    const token = options.provisionerToken;
    if (!token || token.includes("\n") || token.includes("\r")) {
      throw new TypeError("provisioner token is required and must not contain newlines");
    }
    const baseUrl = validateBaseUrl(options.providerUrl);
    const secret = (this.#secret ??= newSecret());
    const registrationId = (this.#registrationId ??= crypto.randomUUID());
    const submission = {
      ...(options.instanceName !== undefined ? { instance_name: options.instanceName } : {}),
      delivery: { type: "webhook", url: options.url, registration_id: registrationId, signing_secret: secret },
    };
    const send = options.fetch ?? ((input, init) => fetch(input, init));
    let response: Response;
    let raw: Uint8Array;
    let tooLarge: boolean;
    try {
      response = await send(`${baseUrl}/v1/instances`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": options.idempotencyKey || registrationId,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(submission),
        redirect: "manual",
        signal: AbortSignal.timeout(40_000),
      });
      ({ raw, tooLarge } = await read(response));
    } catch (err) {
      throw new ProvisionError("the provider could not be reached", { cause: err });
    }
    const instance = provisioned(response.status, raw, tooLarge);
    this.#client = new Client(baseUrl, instance.token, options.fetch ? { fetch: options.fetch } : {});
    this.#factory = undefined;
    this.#loading = undefined;
    this.#instanceId = instance.instanceId;
    return { ...instance, secret, registrationId };
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

/** Check a provisioning answer and return the instance and credential. */
function provisioned(status: number, raw: Uint8Array, tooLarge: boolean): Omit<Provisioned, "secret" | "registrationId"> {
  if (status !== 200 && status !== 201) {
    let code: string | undefined;
    try {
      const error = plain(loads(raw)) as { error?: { code?: unknown } };
      if (typeof error.error?.code === "string") code = error.error.code;
    } catch {
      // The provider's error body is optional.
    }
    if (status === 422 && code === "webhook_verification_failed") {
      throw new WebhookVerificationFailed("the provider could not verify the receiver", { status, code });
    }
    throw new ProvisionError(`provisioning failed (HTTP ${status}${code ? `: ${code}` : ""})`, { status, code });
  }
  if (tooLarge) throw new ProtocolError("AAP response too large");
  const body = plain(loads(raw)) as { instance?: Record<string, unknown>; credential?: Record<string, unknown> } | null;
  const instance = body?.instance;
  const credential = body?.credential;
  const fields = [instance?.id, instance?.name, credential?.token];
  const expiresAt = credential?.expires_at;
  if (!fields.every((v) => typeof v === "string" && v !== "") || !(expiresAt === undefined || typeof expiresAt === "string")) {
    throw new ProtocolError("invalid provisioning response");
  }
  const [instanceId, instanceName, token] = fields as string[];
  return { instanceId: instanceId!, instanceName: instanceName!, token: token!, ...(expiresAt !== undefined ? { expiresAt } : {}) };
}
