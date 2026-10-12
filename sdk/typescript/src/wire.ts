/**
 * Strict parsing of AAP wire objects.
 *
 * Protocol objects reject unknown fields, nulls and duplicate keys. Tool
 * arguments and runtime context keep arbitrary JSON. The parser keeps each
 * number's source text so a response can be compared exactly with the
 * submission, beyond the precision of a JavaScript number.
 */

export const PENDING = "pending";
export const APPROVED = "approved";
export const DENIED = "denied";
export const EXPIRED = "expired";
export const CANCELLED = "cancelled";
const TERMINAL = new Set<string>([APPROVED, DENIED, EXPIRED, CANCELLED]);
const OUTCOMES = new Set<string>(["succeeded", "failed"]);

export type Status = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type OutcomeStatus = "succeeded" | "failed";

/** Any JSON value. Numbers beyond 2^53 lose precision here, never in comparisons. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** The provider sent a response that does not satisfy the AAP contract. */
export class ProtocolError extends Error {
  override name = "ProtocolError";
}

export interface Outcome {
  status: OutcomeStatus;
  reportedAt: Date;
  note?: string;
}

export interface Consumption {
  consumedAt: Date;
  outcome?: Outcome;
}

export interface Decision {
  status: Exclude<Status, "pending">;
  decidedAt: Date;
  note?: string;
  expiresAt?: Date;
}

/** An approval request as the provider returned it. */
export interface ApprovalRequest {
  id: string;
  tool: string;
  server?: string;
  arguments: JsonObject;
  timeout: string;
  agentReasoning?: string;
  context?: JsonObject;
  status: Status;
  createdAt: Date;
  deadlineAt: Date;
  decision?: Decision;
  consumption?: Consumption;
}

// Raw JSON: the parser's output. Numbers keep their source text and objects
// have no prototype, so a "__proto__" key is an ordinary key.

export class RawNumber {
  constructor(readonly text: string) {}
}

export type Raw = null | boolean | string | RawNumber | Raw[] | RawObject;
export type RawObject = { [key: string]: Raw };

export function isRawObject(value: Raw | undefined): value is RawObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof RawNumber);
}

const MAX_DEPTH = 512;

/** Parse JSON, rejecting duplicate keys and keeping numbers exact. */
export function loads(input: string | Uint8Array): Raw {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      throw new ProtocolError("invalid JSON");
    }
  }
  const parser = new Parser(text);
  parser.space();
  const value = parser.value(0);
  parser.space();
  if (parser.at < text.length) parser.fail();
  return value;
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

class Parser {
  at = 0;
  constructor(readonly text: string) {}

  fail(): never {
    throw new ProtocolError("invalid JSON");
  }

  space(): void {
    const t = this.text;
    while (this.at < t.length) {
      const c = t.charCodeAt(this.at);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      this.at++;
    }
  }

  literal(word: string): void {
    if (!this.text.startsWith(word, this.at)) this.fail();
    this.at += word.length;
  }

  value(depth: number): Raw {
    if (depth > MAX_DEPTH) this.fail();
    const c = this.text[this.at];
    if (c === "{") return this.object(depth + 1);
    if (c === "[") return this.array(depth + 1);
    if (c === '"') return this.string();
    if (c === "t") return this.literal("true"), true;
    if (c === "f") return this.literal("false"), false;
    if (c === "n") return this.literal("null"), null;
    NUMBER.lastIndex = this.at;
    const match = NUMBER.exec(this.text);
    if (!match) this.fail();
    this.at += match[0].length;
    return new RawNumber(match[0]);
  }

  object(depth: number): RawObject {
    const out: RawObject = Object.create(null);
    this.at++;
    this.space();
    if (this.text[this.at] === "}") {
      this.at++;
      return out;
    }
    for (;;) {
      if (this.text[this.at] !== '"') this.fail();
      const key = this.string();
      if (key in out) throw new ProtocolError("duplicate JSON key");
      this.space();
      if (this.text[this.at] !== ":") this.fail();
      this.at++;
      this.space();
      out[key] = this.value(depth);
      this.space();
      const c = this.text[this.at++];
      if (c === "}") return out;
      if (c !== ",") this.fail();
      this.space();
    }
  }

  array(depth: number): Raw[] {
    const out: Raw[] = [];
    this.at++;
    this.space();
    if (this.text[this.at] === "]") {
      this.at++;
      return out;
    }
    for (;;) {
      out.push(this.value(depth));
      this.space();
      const c = this.text[this.at++];
      if (c === "]") return out;
      if (c !== ",") this.fail();
      this.space();
    }
  }

  string(): string {
    const t = this.text;
    let out = "";
    let start = ++this.at;
    for (;;) {
      if (this.at >= t.length) this.fail();
      const c = t.charCodeAt(this.at);
      if (c === 0x22) {
        out += t.slice(start, this.at++);
        return out;
      }
      if (c < 0x20) this.fail();
      if (c !== 0x5c) {
        this.at++;
        continue;
      }
      out += t.slice(start, this.at);
      const e = t[this.at + 1];
      if (e === "u") {
        const hex = t.slice(this.at + 2, this.at + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail();
        out += String.fromCharCode(parseInt(hex, 16));
        this.at += 6;
      } else if (e !== undefined && e in ESCAPES) {
        out += ESCAPES[e];
        this.at += 2;
      } else {
        this.fail();
      }
      start = this.at;
    }
  }
}

/** Convert parsed JSON to plain values. Integers beyond 2^53 lose precision. */
export function plain(value: Raw): Json {
  if (value instanceof RawNumber) return Number(value.text);
  if (Array.isArray(value)) return value.map(plain);
  if (isRawObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, { value: plain(value[key]!), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

/**
 * Serialize a submission canonically, byte for byte like the Python SDK's
 * `dumps`: keys sorted by code point, no spaces, non-ASCII unescaped, and
 * numbers written like Python writes an int (integral values and bigints)
 * or a float. Object properties set to undefined are left out. Parsed
 * values from `loads` keep their numbers' source text.
 */
export function dumps(value: unknown): string {
  return encode(value, 0);
}

function encode(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError("value is nested too deeply");
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return string(value);
  if (typeof value === "number") return number(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof RawNumber) return value.text;
  if (Array.isArray(value)) return `[${value.map((item) => encode(item, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`${(value as object).constructor?.name ?? "object"} is not JSON serializable`);
    }
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort(byCodePoint)) {
      if (record[key] === undefined) continue;
      parts.push(`${string(key)}:${encode(record[key], depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`${typeof value} is not JSON serializable`);
}

function string(value: string): string {
  if (/\p{Cs}/u.test(value)) throw new TypeError("string contains a lone surrogate");
  // For well-formed strings JSON.stringify escapes exactly what Python's
  // json.dumps(ensure_ascii=False) escapes, with the same lowercase hex.
  return JSON.stringify(value);
}

function number(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("out of range float values are not JSON compliant");
  if (Number.isInteger(value)) return BigInt(value).toString();
  // Python's float repr: the shortest round-trip digits, in exponent form
  // only below 1e-4 (a non-integral double is always below 2^53).
  const [mantissa, exponent] = value.toExponential().split("e") as [string, string];
  const e = Number(exponent);
  if (e < -4) return `${mantissa}e-${String(-e).padStart(2, "0")}`;
  return String(value);
}

function byCodePoint(a: string, b: string): number {
  const x = a[Symbol.iterator]();
  const y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next();
    const q = y.next();
    if (p.done || q.done) return p.done && q.done ? 0 : p.done ? -1 : 1;
    const d = p.value.codePointAt(0)! - q.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

/** A number's exact value as normalized text, so 1.50 and 1.5e0 compare equal. */
function decimal(text: string): string {
  const [, sign, whole, fraction = "", exponent = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text)!;
  const digits = (whole! + fraction).replace(/^0+/, "");
  if (!digits) return "0";
  const trimmed = digits.replace(/0+$/, "");
  const scale = BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - trimmed.length);
  return `${sign}${trimmed}e${scale}`;
}

/** JSON equality that keeps booleans, numbers and strings distinct and compares numbers exactly. */
export function same(a: Raw | undefined, b: Raw | undefined): boolean {
  if (a instanceof RawNumber || b instanceof RawNumber) {
    return a instanceof RawNumber && b instanceof RawNumber && decimal(a.text) === decimal(b.text);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  if (isRawObject(a) || isRawObject(b)) {
    if (!isRawObject(a) || !isRawObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && same(a[key], b[key]));
  }
  return a === b;
}

// Timestamps are compared in microseconds, like the Python SDK.

const TIMESTAMP = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?Z$/;

/** Microseconds since the epoch for an AAP timestamp. */
export function timestamp(value: Raw | undefined): bigint {
  const match = typeof value === "string" ? TIMESTAMP.exec(value) : null;
  if (!match) throw new ProtocolError("invalid timestamp");
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (year < 1 || monthDays === undefined || day < 1 || day > monthDays || hour > 23 || minute > 59 || second > 59) {
    throw new ProtocolError("invalid timestamp");
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const micros = BigInt((match[7] ?? "").slice(0, 6).padEnd(6, "0"));
  return BigInt(date.getTime()) * 1000n + micros;
}

/** The current time in microseconds since the epoch. */
export function nowMicros(): bigint {
  return BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000));
}

function toDate(micros: bigint): Date {
  return new Date(Number(micros / 1000n));
}

function object(value: Raw | undefined, allowed: readonly string[], required: readonly string[]): RawObject {
  if (!isRawObject(value)) throw new ProtocolError("invalid AAP object");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key) || value[key] === null) throw new ProtocolError("invalid AAP field");
  }
  for (const key of required) {
    if (!(key in value)) throw new ProtocolError("missing AAP field");
  }
  return value;
}

function text(value: Raw | undefined): string {
  if (typeof value !== "string" || !value) throw new ProtocolError("invalid AAP field");
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a parsed request keeps for exact comparison. */
interface Exact {
  arguments: RawObject;
  context?: RawObject;
  createdAt: bigint;
  deadlineAt: bigint;
  decidedAt?: bigint;
  expiresAt?: bigint;
}

const exact = new WeakMap<ApprovalRequest, Exact>();

export function exactOf(request: ApprovalRequest): Exact {
  const found = exact.get(request);
  if (!found) throw new ProtocolError("request was not parsed by this SDK");
  return found;
}

export function parseRequest(value: Raw): ApprovalRequest {
  const obj = object(
    value,
    ["id", "tool", "server", "arguments", "timeout", "agent_reasoning", "context", "status", "created_at", "deadline_at", "decision", "consumption"],
    ["id", "tool", "arguments", "timeout", "status", "created_at", "deadline_at"],
  );
  const id = obj.id;
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new ProtocolError("invalid request ID");
  }
  const args = obj.arguments;
  const context = obj.context;
  if (!isRawObject(args) || ("context" in obj && !isRawObject(context))) throw new ProtocolError("invalid AAP field");
  if ("agent_reasoning" in obj && typeof obj.agent_reasoning !== "string") throw new ProtocolError("invalid AAP field");
  const status = obj.status;
  if (typeof status !== "string" || (status !== PENDING && !TERMINAL.has(status))) throw new ProtocolError("invalid status");
  const created = timestamp(obj.created_at);
  const deadline = timestamp(obj.deadline_at);
  if (deadline <= created) throw new ProtocolError("deadline is not after creation");

  let decision: Decision | undefined;
  let decided: bigint | undefined;
  let expires: bigint | undefined;
  if (status === PENDING) {
    if ("decision" in obj || "consumption" in obj) throw new ProtocolError("pending request has a decision");
  } else {
    if (!("decision" in obj)) throw new ProtocolError("terminal request has no decision");
    const d = object(obj.decision, ["status", "note", "decided_at", "expires_at"], ["status", "decided_at"]);
    decided = timestamp(d.decided_at);
    if (d.status !== status || decided < created) throw new ProtocolError("decision does not match the request");
    if (status === APPROVED) {
      if (!("expires_at" in d)) throw new ProtocolError("approval has no expiry");
      expires = timestamp(d.expires_at);
      if (expires <= decided) throw new ProtocolError("approval expires before it was decided");
    } else if ("expires_at" in d) {
      throw new ProtocolError("only approvals expire");
    }
    decision = { status: status as Decision["status"], decidedAt: toDate(decided) };
    if ("note" in d) decision.note = text(d.note);
    if (expires !== undefined) decision.expiresAt = toDate(expires);
  }

  let consumption: Consumption | undefined;
  if ("consumption" in obj) {
    if (status !== APPROVED) throw new ProtocolError("only approvals are consumed");
    const c = object(obj.consumption, ["consumed_at", "outcome"], ["consumed_at"]);
    const consumed = timestamp(c.consumed_at);
    if (decided === undefined || consumed < decided) throw new ProtocolError("consumed before the decision");
    consumption = { consumedAt: toDate(consumed) };
    if ("outcome" in c) {
      const o = object(c.outcome, ["status", "note", "reported_at"], ["status", "reported_at"]);
      const reported = timestamp(o.reported_at);
      if (typeof o.status !== "string" || !OUTCOMES.has(o.status) || reported < consumed) throw new ProtocolError("invalid outcome");
      consumption.outcome = { status: o.status as OutcomeStatus, reportedAt: toDate(reported) };
      if ("note" in o) consumption.outcome.note = text(o.note);
    }
  }

  const request: ApprovalRequest = {
    id,
    tool: text(obj.tool),
    arguments: plain(args) as JsonObject,
    timeout: text(obj.timeout),
    status: status as Status,
    createdAt: toDate(created),
    deadlineAt: toDate(deadline),
  };
  if ("server" in obj) request.server = text(obj.server);
  if ("agent_reasoning" in obj) request.agentReasoning = obj.agent_reasoning as string;
  if (isRawObject(context)) request.context = plain(context) as JsonObject;
  if (decision) request.decision = decision;
  if (consumption) request.consumption = consumption;
  exact.set(request, { arguments: args, context: isRawObject(context) ? context : undefined, createdAt: created, deadlineAt: deadline, decidedAt: decided, expiresAt: expires });
  return request;
}

/** Whether a returned request is the one submitted, unchanged since it was last seen. */
export function matches(request: ApprovalRequest, submission: RawObject, previous?: ApprovalRequest): boolean {
  const got = exactOf(request);
  if (
    request.tool !== submission.tool ||
    request.server !== submission.server ||
    request.timeout !== submission.timeout ||
    request.agentReasoning !== submission.agent_reasoning ||
    !same(got.arguments, submission.arguments) ||
    !same(got.context ?? Object.create(null), submission.context ?? Object.create(null))
  ) {
    return false;
  }
  if (previous !== undefined) {
    const before = exactOf(previous);
    if (request.id !== previous.id || got.createdAt !== before.createdAt || got.deadlineAt !== before.deadlineAt) return false;
  }
  return true;
}
