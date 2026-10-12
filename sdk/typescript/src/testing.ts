/**
 * An in-memory AAP provider for tests.
 *
 * `FakeProvider` implements the AAP request operations, including consume
 * and outcome, as a `fetch`-compatible function, so a `Client` talks to it
 * without a network. Framework integrations run the conformance scenarios in
 * their own tests against it.
 */

import { Client, type ClientOptions } from "./client.js";
import { sign } from "./receiver.js";
import { type RawObject, dumps, loads, nowMicros, plain } from "./wire.js";

export const BASE_URL = "https://provider.test/aap";
export const TOKEN = "test-token";
export const SECRET = "whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const INSTANCE_ID = "b29a43a7-1949-4b9f-9d61-b7ae66f85d31";

type Body = Record<string, unknown>;

function stamp(micros: bigint): string {
  const seconds = new Date(Number(micros / 1000n)).toISOString().slice(0, 19);
  return `${seconds}.${String(micros % 1_000_000n).padStart(6, "0")}Z`;
}

/** One stored request. */
export class Stored {
  status = "pending";
  note?: string;
  decidedAt?: bigint;
  expiresAt?: bigint;
  consumedKey?: string;
  consumedAt?: bigint;
  outcome?: Body;

  /** The submission as parsed JSON, for assertions. */
  readonly body: Body;

  constructor(
    /** The submission with its numbers' exact text. */
    readonly raw: RawObject,
    readonly id: string,
    readonly createdAt: bigint,
    readonly deadlineAt: bigint,
  ) {
    this.body = plain(raw) as Body;
  }

  wire(): Body {
    const out: Body = { ...this.raw, id: this.id, status: this.status, created_at: stamp(this.createdAt), deadline_at: stamp(this.deadlineAt) };
    if (this.decidedAt !== undefined) {
      const decision: Body = { status: this.status, decided_at: stamp(this.decidedAt) };
      if (this.note) decision.note = this.note;
      if (this.expiresAt !== undefined) decision.expires_at = stamp(this.expiresAt);
      out.decision = decision;
    }
    if (this.consumedAt !== undefined) {
      out.consumption = { consumed_at: stamp(this.consumedAt), ...(this.outcome ? { outcome: this.outcome } : {}) };
    }
    return out;
  }
}

export interface FakeProviderOptions {
  /** Decide each new request at once with this status. `null` keeps requests pending. Default `approved`. */
  auto?: string | null;
  /** How long an approval may be consumed, in milliseconds. Default five minutes. */
  validity?: number;
}

/** In-memory provider. */
export class FakeProvider {
  auto: string | null;
  validity: number;
  readonly requests = new Map<string, Stored>();
  readonly keys = new Map<string, string>();
  readonly calls: [method: string, path: string][] = [];
  /** Optional hook to replace a response: return a Response to use it, or throw to fail the transport. */
  intercept?: (request: Request) => Response | undefined | Promise<Response | undefined>;

  constructor(options: FakeProviderOptions = {}) {
    this.auto = options.auto === undefined ? "approved" : options.auto;
    this.validity = options.validity ?? 5 * 60_000;
  }

  // Test controls

  decide(requestId: string, status = "approved", note?: string): void {
    const stored = this.requests.get(requestId);
    if (!stored) throw new Error(`unknown request ${requestId}`);
    this.#decide(stored, status, note);
  }

  only(): Stored {
    if (this.requests.size !== 1) throw new Error(`expected one request, found ${this.requests.size}`);
    return [...this.requests.values()][0]!;
  }

  client(options: Omit<ClientOptions, "fetch"> = {}): Client {
    return new Client(BASE_URL, TOKEN, { ...options, fetch: this.fetch });
  }

  /** Headers and body of a signed request.resolved notification. */
  async webhook(requestId: string, options: { instanceId?: string; secret?: string } = {}): Promise<{ headers: Record<string, string>; body: string }> {
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({ id: eventId, type: "request.resolved", instance_id: options.instanceId ?? INSTANCE_ID, request_id: requestId, created_at: stamp(nowMicros()) });
    const at = Math.floor(Date.now() / 1000);
    const signature = await sign(options.secret ?? SECRET, eventId, at, body);
    return { headers: { "webhook-id": eventId, "webhook-timestamp": String(at), "webhook-signature": signature }, body };
  }

  // Transport

  /** The provider as a `fetch` function. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (this.intercept) {
      const replaced = await this.intercept(request.clone());
      if (replaced !== undefined) return replaced;
    }
    return this.respond(request);
  };

  #decide(stored: Stored, status: string, note: string | undefined): void {
    if (stored.status !== "pending") return;
    const now = nowMicros();
    stored.status = status;
    stored.note = note;
    stored.decidedAt = now;
    stored.expiresAt = status === "approved" ? now + BigInt(Math.max(1, Math.round(this.validity * 1000))) : undefined;
  }

  /** Answer one request as the provider would, ignoring `intercept`. */
  async respond(request: Request): Promise<Response> {
    const text = await request.text();
    // Everything below runs without awaiting, so concurrent calls see a consistent store.
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 });
    const pathname = new URL(request.url).pathname;
    const path = pathname.startsWith("/aap/v1/requests") ? pathname.slice("/aap/v1/requests".length) : pathname;
    this.calls.push([request.method, path || "/"]);
    const key = request.headers.get("idempotency-key");
    if (request.method === "POST" && path === "") {
      if (!key) return error(400, "invalid_request", "missing_idempotency_key");
      const body = loads(text) as RawObject;
      const existing = this.keys.get(key);
      if (existing !== undefined) {
        const stored = this.requests.get(existing)!;
        if (dumps(stored.raw) !== dumps(body)) return error(409, "conflict", "idempotency_conflict");
        return json(200, stored.wire());
      }
      const now = nowMicros();
      const stored = new Stored(body, crypto.randomUUID(), now, now + 30n * 60n * 1_000_000n);
      this.requests.set(stored.id, stored);
      this.keys.set(key, stored.id);
      if (this.auto) this.#decide(stored, this.auto, undefined);
      return json(201, stored.wire());
    }
    const parts = path.replace(/^\/+|\/+$/g, "").split("/");
    const stored = this.requests.get(parts[0]!);
    if (stored === undefined) return error(404, "not_found", "not_found");
    const action = parts.slice(1).join("/");
    if (request.method === "GET" && parts.length === 1) return json(200, stored.wire());
    if (request.method === "DELETE" && parts.length === 1) {
      if (stored.status !== "pending" && stored.status !== "cancelled") return error(409, "conflict", "already_terminal");
      this.#decide(stored, "cancelled", undefined);
      return json(200, stored.wire());
    }
    if (request.method === "POST" && action === "consume") {
      if (!key) return error(400, "invalid_request", "missing_idempotency_key");
      if (stored.consumedKey === key) return json(200, stored.wire());
      if (stored.consumedKey !== undefined) return error(409, "conflict", "already_consumed");
      if (stored.status !== "approved") return error(409, "conflict", "not_approved");
      if (stored.expiresAt === undefined || nowMicros() >= stored.expiresAt) return error(409, "conflict", "approval_expired");
      stored.consumedKey = key;
      stored.consumedAt = nowMicros();
      return json(200, stored.wire());
    }
    if (request.method === "POST" && action === "outcome") {
      const report = JSON.parse(text) as Body;
      if (stored.consumedAt === undefined) return error(409, "conflict", "not_consumed");
      if (stored.outcome !== undefined) {
        const same = stored.outcome.status === report.status && stored.outcome.note === report.note;
        return same ? json(200, stored.wire()) : error(409, "conflict", "outcome_conflict");
      }
      stored.outcome = { ...report, reported_at: stamp(nowMicros()) };
      return json(200, stored.wire());
    }
    return new Response(null, { status: 405 });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(dumps(body), { status, headers: { "content-type": "application/json" } });
}

function error(status: number, type: string, code: string): Response {
  return json(status, { error: { type, code, message: code, request_id: crypto.randomUUID() } });
}
