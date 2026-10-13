import assert from "node:assert/strict";
import { test } from "node:test";

import { type Call, type Deny, Gate } from "../src/index.js";
import { idempotencyKey, submission } from "../src/gate.js";
import { FakeProvider } from "../src/testing.js";
import { dumps } from "../src/wire.js";

const quiet = { warn() {}, error() {} };

function call(overrides: Partial<Call> = {}): Call {
  return { key: "run-1:call-1", tool: "issue_refund", arguments: { payment_id: "payment_123", amount: 4900, exact: 0.1 }, server: "stripe", ...overrides };
}

function denied(verdict: { kind: string }): Deny {
  assert.equal(verdict.kind, "deny");
  return verdict as Deny;
}

test("approved call is consumed and reported", async () => {
  const provider = new FakeProvider();
  const gate = new Gate(provider.client());
  let ran = 0;
  const result = await gate.guard(call(), () => ++ran);
  assert.equal(result.kind, "allow");
  assert.equal(ran, 1);
  const stored = provider.only();
  assert.notEqual(stored.consumedAt, undefined);
  assert.equal(stored.outcome?.status, "succeeded");
  assert.equal((stored.body.context as Record<string, unknown>).call_id, "run-1:call-1");
});

test("failure inside guard reports failed", async () => {
  const provider = new FakeProvider();
  await assert.rejects(
    new Gate(provider.client()).guard(call(), () => {
      throw new Error("tool broke");
    }),
    /tool broke/,
  );
  assert.equal(provider.only().outcome?.status, "failed");
});

test("denial carries the reviewer's note", async () => {
  const provider = new FakeProvider({ auto: null });
  const gate = new Gate(provider.client(), { mode: "async" });
  const pending = await gate.check(call());
  assert.equal(pending.kind, "pending");
  provider.decide(pending.requestId!, "denied", "Refunds over 40 GBP need a manager.");
  let ran = false;
  const verdict = denied(await gate.guard(call(), () => (ran = true)));
  assert.equal(verdict.status, "denied");
  assert.equal(verdict.reason, "The Agent Approval Protocol (AAP) provider denied this call: Refunds over 40 GBP need a manager.");
  assert.equal(ran, false);
});

test("same call cannot run twice across replicas", async () => {
  const provider = new FakeProvider();
  const gates = Array.from({ length: 8 }, () => new Gate(provider.client()));
  const results = await Promise.all(gates.map((gate) => gate.check(call())));
  assert.equal(results.filter((v) => v.kind === "allow").length, 1);
  assert.ok(results.filter((v) => v.kind === "deny").every((v) => (v as Deny).status === "consumed"));
  assert.equal(provider.requests.size, 1);
});

test("replay after consumption is refused", async () => {
  const provider = new FakeProvider();
  assert.equal((await new Gate(provider.client()).check(call())).kind, "allow");
  const again = denied(await new Gate(provider.client()).check(call()));
  assert.equal(again.status, "consumed");
});

test("async mode pauses then allows the same request", async () => {
  const provider = new FakeProvider({ auto: null });
  const gate = new Gate(provider.client(), { mode: "async" });
  const resume = { framework: "test", thread_id: "t1" };
  const first = await gate.check(call({ resume }));
  assert.equal(first.kind, "pending");
  // A forged or early wake-up finds the request still pending.
  assert.equal((await gate.check(call({ resume }))).kind, "pending");
  provider.decide(first.requestId!);
  const allowed = await gate.check(call({ resume }));
  assert.equal(allowed.kind, "allow");
  assert.equal(allowed.requestId, first.requestId);
  assert.deepEqual((provider.only().body.context as Record<string, unknown>).resume, resume);
});

test("changed arguments need a new approval", async () => {
  const provider = new FakeProvider({ auto: null });
  const gate = new Gate(provider.client(), { mode: "async" });
  const first = await gate.check(call());
  provider.decide(first.requestId!);
  const changed = await gate.check(call({ arguments: { payment_id: "payment_123", amount: 99999, exact: 0.1 } }));
  assert.equal(changed.kind, "pending");
  assert.notEqual(changed.requestId, first.requestId);
});

test("hybrid waits when the call cannot pause", async () => {
  const provider = new FakeProvider({ auto: null });
  provider.intercept = (request) => {
    if (request.method === "GET") for (const id of provider.requests.keys()) provider.decide(id);
    return undefined;
  };
  const verdict = await new Gate(provider.client(), { mode: "async" }).check(call(), { canPause: false });
  assert.equal(verdict.kind, "allow");
});

test("sync wait limit cancels and denies", async () => {
  const provider = new FakeProvider({ auto: null });
  const verdict = denied(await new Gate(provider.client(), { waitLimit: 0 }).check(call()));
  assert.equal(verdict.status, "expired");
  assert.equal(provider.only().status, "cancelled");
});

test("expired approval does not run", async () => {
  const provider = new FakeProvider({ validity: 0.001 });
  const verdict = denied(await new Gate(provider.client()).check(call()));
  assert.equal(verdict.status, "expired");
  assert.equal(provider.only().consumedAt, undefined);
});

const badResponses: [string, () => Response][] = [
  ["an unknown field", () => new Response('{"surprise": true}', { status: 200 })],
  ["a server error", () => new Response(null, { status: 500 })],
  ["a redirect", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } })],
];

for (const [name, response] of badResponses) {
  test(`bad provider responses fail closed: ${name}`, async () => {
    const provider = new FakeProvider();
    provider.intercept = () => response();
    const verdict = denied(await new Gate(provider.client({ retryBudget: 0.3 })).check(call()));
    assert.equal(verdict.status, "error");
  });
}

test("unreachable provider fails closed", async () => {
  const provider = new FakeProvider();
  provider.intercept = () => {
    throw new TypeError("fetch failed");
  };
  assert.equal((await new Gate(provider.client({ retryBudget: 0.3 })).check(call())).kind, "deny");
});

test("substituted request fails closed", async () => {
  const provider = new FakeProvider();
  provider.intercept = async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/requests")) {
      const response = await provider.respond(request);
      const body = await response.json();
      body.arguments.amount = 1;
      return new Response(JSON.stringify(body), { status: response.status });
    }
    return undefined;
  };
  const verdict = denied(await new Gate(provider.client()).check(call()));
  assert.equal(verdict.status, "error");
  assert.equal(provider.only().consumedAt, undefined);
});

test("a number beyond double precision must match exactly", async () => {
  const big = call({ arguments: { amount: 9007199254740993n } });
  assert.equal((await new Gate(new FakeProvider().client()).check(big)).kind, "allow");
  const provider = new FakeProvider();
  provider.intercept = async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/requests")) {
      const response = await provider.respond(request);
      const text = (await response.text()).replace('"amount":9007199254740993', '"amount":9007199254740992');
      return new Response(text, { status: response.status });
    }
    return undefined;
  };
  const verdict = denied(await new Gate(provider.client()).check(big));
  assert.equal(verdict.status, "error");
});

test("refused credential says so", async () => {
  const provider = new FakeProvider();
  provider.intercept = () => new Response(null, { status: 401 });
  const verdict = denied(await new Gate(provider.client()).check(call()));
  assert.match(verdict.reason, /refused this agent's credential/);
});

test("consume retry keeps its key", async () => {
  const provider = new FakeProvider();
  const keys: string[] = [];
  provider.intercept = (request) => {
    if (new URL(request.url).pathname.endsWith("/consume")) {
      keys.push(request.headers.get("idempotency-key")!);
      if (keys.length === 1) return new Response(null, { status: 503 });
    }
    return undefined;
  };
  assert.equal((await new Gate(provider.client()).check(call())).kind, "allow");
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("pause, guard and replay follow the same rules", async () => {
  const provider = new FakeProvider({ auto: null });
  const gate = new Gate(provider.client(), { mode: "async" });
  const pending = await gate.check(call());
  assert.equal(pending.kind, "pending");
  provider.decide(pending.requestId!);
  const ran = await gate.guard(call(), () => "done");
  assert.deepEqual(ran, { kind: "allow", requestId: pending.requestId, value: "done" });
  assert.equal(provider.only().outcome?.status, "succeeded");
  const replay = denied(await new Gate(provider.client(), { mode: "async" }).check(call()));
  assert.equal(replay.status, "consumed");
});

test("values that are not JSON fail closed", async () => {
  const provider = new FakeProvider();
  const verdict = denied(await new Gate(provider.client(), { logger: quiet }).check(call({ arguments: { at: new Date() } })));
  assert.equal(verdict.status, "error");
  assert.equal(provider.requests.size, 0);
});

test("the idempotency key matches the Python SDK", async () => {
  // Values from agentapprovalprotocol._gate.submission and idempotency_key for the same call.
  const same: Call = {
    key: "run-1:call-1",
    tool: "issue_refund",
    arguments: {
      payment_id: "payment_123",
      amount: 4900,
      exact: 0.1,
      tiny: 1.5e-5,
      small: 0.0001,
      neg: -2.5,
      big: 123456789012345678901234567890n,
      text: 'café ☃ \u{1F600} "q" \\ \n\t\x01\x7f ',
      list: [true, false, null, { b: 1, a: 2 }],
      "￿": 1,
      "\u{1F600}": 2,
      z: 3,
      A: 4,
      skipped: undefined,
    },
    server: "stripe",
    reasoning: "Customer asked for a refund.",
    context: { run_id: "r1" },
    resume: { framework: "test", thread_id: "t1" },
  };
  const body = submission(same, "10m", { agent: "a" });
  assert.equal(
    dumps(body),
    '{"agent_reasoning":"Customer asked for a refund.","arguments":{"A":4,"amount":4900,"big":123456789012345678901234567890,"exact":0.1,' +
      '"list":[true,false,null,{"a":2,"b":1}],"neg":-2.5,"payment_id":"payment_123","small":0.0001,' +
      '"text":"café ☃ \u{1F600} \\"q\\" \\\\ \\n\\t\\u0001\x7f ","tiny":1.5e-05,"z":3,"￿":1,"\u{1F600}":2},' +
      '"context":{"agent":"a","call_id":"run-1:call-1","resume":{"framework":"test","thread_id":"t1"},"run_id":"r1"},' +
      '"server":"stripe","timeout":"10m","tool":"issue_refund"}',
  );
  assert.equal(await idempotencyKey(same, body), "ccffee53c046aa046169529bf641d32dae3eb2cdaad2688fed90c225ae88c64d");
});
