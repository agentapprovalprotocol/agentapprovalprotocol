/**
 * AAP HTTP client.
 *
 * Transport failures, 429 and 5xx responses are retried with the same
 * idempotency key until the retry budget runs out. Redirects are never
 * followed.
 */

import { type ApprovalRequest, type OutcomeStatus, ProtocolError, dumps, isRawObject, loads, parseRequest, plain } from "./wire.js";

export const USER_AGENT = "agentapprovalprotocol-typescript";
const MAX_RESPONSE = 8 << 20;

/** A `fetch`-compatible function. */
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The operation did not produce a usable result. */
export class AAPError extends Error {
  override name = "AAPError";
}

/** The provider refused the instance credential (HTTP 401 or 403). */
export class CredentialRefused extends AAPError {
  override name = "CredentialRefused";
}

/** A 409 answer, identified by the provider's error code. */
export class ConflictError extends AAPError {
  override name = "ConflictError";
  constructor(
    readonly code: string,
    readonly detail: string = "",
  ) {
    super(`AAP conflict: ${code}`);
  }
}

/** The request is unknown or unavailable to this instance. */
export class NotFound extends AAPError {
  override name = "NotFound";
}

/**
 * Provisioning an instance failed. `status` is the HTTP status and `code`
 * the provider's error code, when the provider answered with them.
 */
export class ProvisionError extends AAPError {
  override name = "ProvisionError";
  readonly status?: number;
  readonly code?: string;
  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.status = options.status;
    this.code = options.code;
  }
}

/** The provider could not verify the receiver (HTTP 422, `webhook_verification_failed`). */
export class WebhookVerificationFailed extends ProvisionError {
  override name = "WebhookVerificationFailed";
}

/** A request submission, in wire field names. */
export interface Submission {
  tool: string;
  arguments: Record<string, unknown>;
  timeout: string;
  server?: string;
  agent_reasoning?: string;
  context?: Record<string, unknown>;
}

export interface ClientOptions {
  /** The `fetch` implementation to use. Defaults to the global `fetch`. */
  fetch?: Fetch;
  /** Seconds to keep retrying transport failures, 429 and 5xx. Default 30. */
  retryBudget?: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function validateBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("base URL must be an absolute AAP URL without credentials, query or fragment");
  }
  if (!url.host || url.username || url.password || url.search || url.hash || baseUrl.includes("?") || baseUrl.includes("#")) {
    throw new TypeError("base URL must be an absolute AAP URL without credentials, query or fragment");
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new TypeError("base URL requires HTTPS, except on localhost");
  }
  return baseUrl.replace(/\/+$/, "");
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - Date.now()) / 1000);
}

/** Read a response body, stopping at the size limit. */
export async function read(response: Response): Promise<{ raw: Uint8Array<ArrayBuffer>; tooLarge: boolean }> {
  if (!response.body) return { raw: new Uint8Array(), tooLarge: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE) {
      await reader.cancel().catch(() => {});
      return { raw: new Uint8Array(), tooLarge: true };
    }
    chunks.push(value);
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { raw, tooLarge: false };
}

/** Turn a final response into a request, throw, or return undefined to retry. */
function result(response: Response, raw: Uint8Array, tooLarge: boolean): ApprovalRequest | undefined {
  const code = response.status;
  if (response.type === "opaqueredirect" || code === 0) throw new AAPError("AAP request failed (HTTP redirect)");
  if (code === 429 || code >= 500) return undefined;
  if (code === 401 || code === 403) throw new CredentialRefused(`the provider refused the instance credential (HTTP ${code})`);
  if (code === 404) throw new NotFound("the request is unavailable");
  if (code === 409) {
    const error = tooLarge ? undefined : conflictBody(raw);
    if (!isRawObject(error) || !("code" in error)) throw new AAPError("AAP request failed (HTTP 409)");
    const message = "message" in error ? error.message! : "";
    throw new ConflictError(text(error.code!), text(message));
  }
  if (code !== 200 && code !== 201) throw new AAPError(`AAP request failed (HTTP ${code})`);
  if (tooLarge) throw new ProtocolError("AAP response too large");
  return parseRequest(loads(raw));
}

function conflictBody(raw: Uint8Array) {
  try {
    const body = loads(raw);
    return isRawObject(body) ? body.error : undefined;
  } catch {
    return undefined;
  }
}

function text(value: Parameters<typeof plain>[0]): string {
  return typeof value === "string" ? value : JSON.stringify(plain(value));
}

const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
const monotonic = () => performance.now() / 1000;

/** AAP client for one instance credential. */
export class Client {
  readonly baseUrl: string;
  readonly retryBudget: number;
  readonly #headers: Record<string, string>;
  readonly #fetch: Fetch;

  constructor(baseUrl: string, token: string, options: ClientOptions = {}) {
    if (!token || token.includes("\n") || token.includes("\r")) {
      throw new TypeError("instance token is required and must not contain newlines");
    }
    this.baseUrl = validateBaseUrl(baseUrl);
    this.retryBudget = options.retryBudget ?? 30;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#headers = { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT };
  }

  async #send(method: string, path: string, body?: object, key?: string, timeout = 40): Promise<ApprovalRequest> {
    const headers: Record<string, string> = { ...this.#headers };
    let content: Uint8Array<ArrayBuffer> | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      content = new TextEncoder().encode(dumps(body));
    }
    if (key !== undefined) headers["Idempotency-Key"] = key;
    const deadline = monotonic() + this.retryBudget;
    let delay = 0.1;
    for (;;) {
      let wait = delay;
      let response: Response | undefined;
      let raw = new Uint8Array();
      let tooLarge = false;
      try {
        response = await this.#fetch(this.baseUrl + path, {
          method,
          headers,
          body: content,
          redirect: "manual",
          signal: AbortSignal.timeout(timeout * 1000),
        });
        ({ raw, tooLarge } = await read(response));
      } catch {
        response = undefined;
      }
      if (response) {
        const request = result(response, raw, tooLarge);
        if (request) return request;
        wait = Math.max(delay, retryAfter(response) ?? 0);
      }
      if (monotonic() + wait > deadline) throw new AAPError("the provider could not be reached");
      await sleep(wait);
      delay = Math.min(delay * 2, 2);
    }
  }

  create(submission: Submission, key: string): Promise<ApprovalRequest> {
    return this.#send("POST", "/v1/requests", submission, key);
  }

  /** Retrieve a request. `wait` long-polls for up to that many seconds while it is pending. */
  get(requestId: string, options: { wait?: number } = {}): Promise<ApprovalRequest> {
    const query = options.wait ? `?wait=${options.wait}s` : "";
    return this.#send("GET", `/v1/requests/${encodeURIComponent(requestId)}${query}`, undefined, undefined, (options.wait ?? 0) + 10);
  }

  cancel(requestId: string): Promise<ApprovalRequest> {
    return this.#send("DELETE", `/v1/requests/${encodeURIComponent(requestId)}`);
  }

  consume(requestId: string, key: string): Promise<ApprovalRequest> {
    return this.#send("POST", `/v1/requests/${encodeURIComponent(requestId)}/consume`, undefined, key);
  }

  reportOutcome(requestId: string, status: OutcomeStatus, note?: string): Promise<ApprovalRequest> {
    return this.#send("POST", `/v1/requests/${encodeURIComponent(requestId)}/outcome`, { status, ...(note ? { note } : {}) });
  }
}
