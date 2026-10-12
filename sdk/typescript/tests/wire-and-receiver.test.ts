import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";

import { Gate, ProtocolError, Receiver, WebhookError, sign, verify } from "../src/index.js";
import { nodeListener } from "../src/node.js";
import { FakeProvider, SECRET } from "../src/testing.js";
import { type Raw, RawNumber, dumps, loads, parseRequest, same } from "../src/wire.js";

const SPEC = new URL("../../../docs/specification/7_async.md", import.meta.url);
const quiet = { warn() {}, error() {} };

type Wire = Record<string, any>;

function approved(extra: Wire = {}): Wire {
  return {
    id: "7ab8c8ec-7b2d-4fd6-9b52-752f9515eb71",
    tool: "issue_refund",
    arguments: { amount: 4900 },
    timeout: "30m",
    status: "approved",
    created_at: "2026-09-16T12:00:00Z",
    deadline_at: "2026-09-16T12:30:00Z",
    decision: { status: "approved", decided_at: "2026-09-16T12:02:00Z", expires_at: "2026-09-16T12:07:00Z" },
    ...extra,
  };
}

const parse = (value: unknown) => parseRequest(loads(JSON.stringify(value)));

test("parses a consumed request with an outcome", () => {
  const request = parse(
    approved({ consumption: { consumed_at: "2026-09-16T12:02:05.123456789Z", outcome: { status: "succeeded", reported_at: "2026-09-16T12:02:07Z" } } }),
  );
  assert.equal(request.consumption?.outcome?.status, "succeeded");
  assert.deepEqual(request.arguments, { amount: 4900 });
  assert.equal(request.decision?.expiresAt?.toISOString(), "2026-09-16T12:07:00.000Z");
});

const malformed: [string, (r: Wire) => void][] = [
  ["an unknown field", (r) => (r.reviewer = "private")],
  ["a null field", (r) => (r.server = null)],
  ["an approval without expiry", (r) => delete r.decision.expires_at],
  ["a status that differs from the decision", (r) => (r.status = "denied")],
  ["a consumption before the decision", (r) => (r.consumption = { consumed_at: "2026-09-16T12:01:00Z" })],
  [
    "an unknown outcome",
    (r) => (r.consumption = { consumed_at: "2026-09-16T12:03:00Z", outcome: { status: "maybe", reported_at: "2026-09-16T12:04:00Z" } }),
  ],
  ["a timestamp without Z", (r) => (r.created_at = "2026-09-16 12:00:00")],
  ["an impossible date", (r) => (r.created_at = "2026-02-30T12:00:00Z")],
  ["a non-UUID ID", (r) => (r.id = "request-1")],
];

for (const [name, change] of malformed) {
  test(`rejects malformed requests: ${name}`, () => {
    const request = approved();
    request.decision = { ...request.decision };
    change(request);
    assert.throws(() => parse(request), ProtocolError);
  });
}

test("rejects duplicate keys", () => {
  assert.throws(() => loads('{"a": 1, "a": 2}'), { name: "ProtocolError", message: "duplicate JSON key" });
  assert.throws(() => loads('{"a": {"__proto__": 1, "__proto__": 2}}'), { message: "duplicate JSON key" });
});

test("rejects invalid JSON", () => {
  for (const text of ["", "{", "[1,]", "{'a': 1}", "NaN", "01", "1.", '"\u0001"', '"\\x"', "1 2", "﻿{}"]) {
    assert.throws(() => loads(text), ProtocolError, text);
  }
  assert.throws(() => loads(new Uint8Array([0x22, 0xff, 0x22])), ProtocolError);
});

test("keeps a __proto__ key as data", () => {
  const value = loads('{"__proto__": {"polluted": true}}');
  assert.equal(({} as Wire).polluted, undefined);
  assert.equal(dumps(value), '{"__proto__":{"polluted":true}}');
});

test("JSON equality keeps types apart", () => {
  assert.ok(same(loads("4900"), new RawNumber("4900")));
  assert.ok(same(loads("1.50"), loads("1.5")));
  assert.ok(same(loads("1.5e3"), loads("1500")));
  assert.ok(same(loads("-0"), loads("0.0")));
  assert.ok(!same(true, new RawNumber("1")));
  assert.ok(!same("1", new RawNumber("1")));
  assert.ok(!same(loads("9007199254740993"), loads("9007199254740992")));
  assert.ok(!same(loads("0.1"), loads("0.10000000000000001")));
  assert.ok(!same(loads('{"a": 1}'), loads('{"a": 1, "b": 1}')));
  assert.ok(!same(loads("[1]") as Raw, loads("[1, 1]")));
});

test("documented signature verifies", async () => {
  const source = readFileSync(SPEC, "utf8");
  const secret = "whsec_" + /"signing_secret": "whsec_([^"]+)"/.exec(source)![1];
  const block = [...source.matchAll(/```http\n([\s\S]*?)\n```/g)].map((m) => m[1]!).find((b) => b.includes("webhook-signature:"))!;
  const split = block.indexOf("\n\n");
  const head = block.slice(0, split);
  const body = block.slice(split + 2);
  const headers = Object.fromEntries(head.split("\n").slice(1).map((line) => line.split(": ", 2) as [string, string]));
  const message = await verify(secret, headers, body, { now: Number(headers["webhook-timestamp"]) });
  assert.equal(message.type, "request.resolved");
  assert.equal(await sign(secret, headers["webhook-id"]!, Number(headers["webhook-timestamp"]), body), headers["webhook-signature"]);
});

test("rejects stale and forged deliveries", async () => {
  const { headers, body } = await new FakeProvider().webhook("7ab8c8ec-7b2d-4fd6-9b52-752f9515eb71");
  await assert.rejects(verify(SECRET, headers, body, { now: Number(headers["webhook-timestamp"]) + 301 }), WebhookError);
  await assert.rejects(verify(SECRET, { ...headers, "webhook-signature": "v1,AAAA" }, body), WebhookError);
});

test("receiver wakes the run from its resume handle", async () => {
  const provider = new FakeProvider();
  const woken: [unknown, string][] = [];
  const tasks: Promise<unknown>[] = [];
  const receiver = new Receiver({
    secret: SECRET,
    client: provider.client(),
    resumers: { test: (handle, request) => void woken.push([handle.thread_id, request.status]) },
    waitUntil: (task) => tasks.push(task),
  });
  await new Gate(provider.client(), { mode: "async" }).check({ key: "k", tool: "t", arguments: {}, resume: { framework: "test", thread_id: "t1" } });
  const { headers, body } = await provider.webhook(provider.only().id);
  assert.equal((await receiver.handle(headers, body)).status, 204);
  await Promise.all(tasks);
  assert.deepEqual(woken, [["t1", "approved"]]);
});

test("receiver answers only its own verification", async () => {
  const receiver = new Receiver({ secret: SECRET, client: new FakeProvider().client(), resumers: {}, registrationId: "8246931c-4ce0-4c15-a94a-e9c078ad06e2" });
  async function delivery(registrationId: string): Promise<[Record<string, string>, string]> {
    const messageId = crypto.randomUUID();
    const body = JSON.stringify({
      id: messageId,
      type: "webhook.verification",
      registration_id: registrationId,
      instance_id: crypto.randomUUID(),
      created_at: "2026-09-16T11:59:00Z",
      challenge: "2edc34d7",
    });
    const stamp = Math.floor(Date.now() / 1000);
    return [{ "webhook-id": messageId, "webhook-timestamp": String(stamp), "webhook-signature": await sign(SECRET, messageId, stamp, body) }, body];
  }
  assert.deepEqual(await receiver.handle(...(await delivery("8246931c-4ce0-4c15-a94a-e9c078ad06e2"))), { status: 200, body: '{"challenge":"2edc34d7"}' });
  assert.equal((await receiver.handle(...(await delivery("00000000-0000-4000-8000-000000000000")))).status, 403);
});

test("receiver refuses bad signatures and other instances", async () => {
  const provider = new FakeProvider();
  const receiver = new Receiver({ secret: SECRET, client: provider.client(), resumers: {}, instanceId: "b29a43a7-1949-4b9f-9d61-b7ae66f85d31" });
  const { headers, body } = await provider.webhook("7ab8c8ec-7b2d-4fd6-9b52-752f9515eb71", { instanceId: "11111111-1111-4111-8111-111111111111" });
  assert.equal((await receiver.handle(headers, body)).status, 403);
  assert.equal((await receiver.handle({ ...headers, "webhook-signature": "v1,AAAA" }, body)).status, 401);
});

test("wake without a usable resume handle does nothing", async () => {
  const provider = new FakeProvider();
  const receiver = new Receiver({ secret: SECRET, client: provider.client(), resumers: { test: () => assert.fail("must not resume") }, logger: quiet });
  await new Gate(provider.client(), { mode: "async" }).check({ key: "k", tool: "t", arguments: {}, resume: { framework: "other" } });
  assert.equal(await receiver.wake(provider.only().id), false);
  assert.equal(await receiver.wake("7ab8c8ec-7b2d-4fd6-9b52-752f9515eb71"), false);
});

test("the Web-standard handler answers webhooks", async () => {
  const provider = new FakeProvider({ auto: null });
  const woken: string[] = [];
  const tasks: Promise<unknown>[] = [];
  const receiver = new Receiver({ secret: SECRET, client: provider.client(), resumers: { test: (_, request) => void woken.push(request.id) }, waitUntil: (t) => tasks.push(t) });
  await new Gate(provider.client(), { mode: "async" }).check({ key: "k", tool: "t", arguments: {}, resume: { framework: "test" } });
  const { headers, body } = await provider.webhook(provider.only().id);
  const response = await receiver.handler(new Request("https://agent.test/aap/events", { method: "POST", headers, body }));
  assert.equal(response.status, 204);
  await Promise.all(tasks);
  assert.deepEqual(woken, [provider.only().id]);
  assert.equal((await receiver.handler(new Request("https://agent.test/aap/events"))).status, 405);
  const forged = await receiver.handler(new Request("https://agent.test/aap/events", { method: "POST", headers: { ...headers, "webhook-signature": "v1,AAAA" }, body }));
  assert.equal(forged.status, 401);
});

test("the Node listener answers webhooks", async () => {
  const provider = new FakeProvider();
  const receiver = new Receiver({ secret: SECRET, client: provider.client(), resumers: {}, logger: quiet });
  const server = createServer(nodeListener(receiver));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const { headers, body } = await provider.webhook("7ab8c8ec-7b2d-4fd6-9b52-752f9515eb71");
    const url = `http://127.0.0.1:${address.port}/aap/events`;
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 204);
    assert.equal((await fetch(url)).status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
