import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAAPExtension, askAdapter } from './assets/pi/index.js';
import openclaw from './assets/openclaw/index.js';

const expires_at = () => new Date(Date.now() + 60000).toISOString();
function piHook(verdict) {
  let handler;
  createAAPExtension({ config: { binary: 'host', configDir: '/aap', approvalTimeoutMs: 60000 }, askAdapter: verdict })(
    { on: (name, fn) => { assert.equal(name, 'tool_call'); handler = fn; } },
  );
  return handler;
}
const context = () => ({ cwd: '/project', sessionManager: { getSessionId: () => 's', getBranch: () => [] } });
const event = () => ({ toolName: 'write', toolCallId: 'c', input: { path: 'x', nested: { amount: 5 } } });

test('Pi defaults to a full week with time to return the decision', async () => {
  const previous = process.env.AAP_APPROVAL_TIMEOUT_MS;
  let handler;
  try {
    delete process.env.AAP_APPROVAL_TIMEOUT_MS;
    createAAPExtension({ askAdapter: async ({ payload, timeoutMs }) => {
      assert.equal(payload.timeout_ms, 604830000);
      assert.equal(timeoutMs, 604890000);
      return { decision: 'allow', gated: false };
    } })({ on: (_name, fn) => { handler = fn; } });
  } finally {
    if (previous === undefined) delete process.env.AAP_APPROVAL_TIMEOUT_MS;
    else process.env.AAP_APPROVAL_TIMEOUT_MS = previous;
  }
  assert.equal(await handler(event(), context()), undefined);
});

test('Pi snapshots and freezes approved arguments', async () => {
  const input = event();
  const hook = piHook(async ({ payload, configDir }) => {
    assert.equal(configDir, '/aap');
    assert.deepEqual(payload.arguments, input.input);
    return { decision: 'allow', gated: true, expires_at: expires_at() };
  });
  assert.equal(await hook(input, context()), undefined);
  assert.ok(Object.isFrozen(input.input.nested));
});
test('Pi blocks argument changes while waiting', async () => {
  const input = event();
  const hook = piHook(async () => { input.input.path = 'other'; return { decision: 'allow', gated: true, expires_at: expires_at() }; });
  assert.equal((await hook(input, context())).block, true);
});
test('Pi rejects expired and missing expiry, but leaves excluded calls alone', async () => {
  for (const expiry of [undefined, '2000-01-01T00:00:00Z']) {
    const hook = piHook(async () => ({ decision: 'allow', gated: true, expires_at: expiry }));
    assert.equal((await hook(event(), context())).block, true);
  }
  const input = event();
  assert.equal(await piHook(async () => ({ decision: 'allow', gated: false }))(input, context()), undefined);
  assert.equal(Object.isFrozen(input.input), false);
});
function executable(t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'aap-plugin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'host');
  writeFileSync(path, '#!/bin/sh\n' + content + '\n'); chmodSync(path, 0o700); return path;
}
test('Pi transport invokes the importing CLI and carries configuration', async t => {
  const binary = executable(t, 'test "$1 $2" = "hook pi" || exit 2\ntest "$AAP_CONFIG_DIR" = "/config space" || exit 3\ncat >/dev/null\nprintf \'{"decision":"allow","gated":false}\'');
  assert.equal((await askAdapter({ binary, configDir: '/config space', payload: {}, timeoutMs: 1000 })).decision, 'allow');
});
test('Pi transport blocks nonzero exit, malformed output and missing executable', async t => {
  for (const script of ['echo broken', 'echo \'{"decision":"allow","gated":false}\'; exit 1']) {
    assert.equal((await askAdapter({ binary: executable(t, script), payload: {}, timeoutMs: 1000 })).decision, 'deny');
  }
  assert.equal((await askAdapter({ binary: '/does/not/exist', payload: {}, timeoutMs: 1000 })).decision, 'deny');
});
function openclawHook(binary, configDir) {
  let handler;
  openclaw.register({ pluginConfig: { binary, configDir }, logger: {}, on: (name, fn, options) => { assert.equal(name, 'before_tool_call'); assert.equal(options.timeoutMs, 604890000); handler = fn; } });
  return handler;
}
test('OpenClaw transport and snapshot return preserve reviewed arguments', async t => {
  const binary = executable(t, `test "$AAP_CONFIG_DIR" = "/aap" || exit 2\ncat | grep -q '"timeout_ms":604830000' || exit 3\necho '{"decision":"allow","gated":true,"expires_at":"${expires_at()}"}'`);
  const input = { toolName: 'write', params: { path: 'x' }, toolCallId: 'c' };
  const result = await openclawHook(binary, '/aap')(input, { sessionId: 's' });
  assert.deepEqual(result.params, input.params); assert.notEqual(result.params, input.params);
});
test('OpenClaw blocks nonzero exits and expired approvals', async t => {
  for (const script of [`echo '{"decision":"allow","gated":false}'; exit 1`, `echo '{"decision":"allow","gated":true,"expires_at":"2000-01-01T00:00:00Z"}'`]) {
    const result = await openclawHook(executable(t, script), '/aap')({ toolName: 'x', params: {} }, {});
    assert.equal(result.block, true);
  }
});
