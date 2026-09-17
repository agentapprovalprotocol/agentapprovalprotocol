import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const publisher = fileURLToPath(new URL('../../scripts/publish-release.sh', import.meta.url));

async function fixture(t, { existing = '', fail = '' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aap publish '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'dist');
  const bin = path.join(dir, 'bin');
  await mkdir(out);
  await mkdir(bin);
  const files = ['aap-darwin-amd64', 'aap-darwin-arm64', 'aap-linux-amd64', 'aap-linux-arm64'];
  const manifest = files.map(name => `${createHash('sha256').update(name).digest('hex')}  ${name}\n`).join('');
  await writeFile(path.join(out, 'SHA256SUMS'), manifest);
  await writeFile(path.join(out, 'metadata.json'), JSON.stringify({ version: '0.1.0' }));
  const artifacts = [];
  for (const name of files) {
    const binaryPath = path.join(out, name);
    await writeFile(binaryPath, name);
    artifacts.push({ type: 'Binary', name, path: binaryPath });
  }
  await writeFile(path.join(out, 'artifacts.json'), JSON.stringify(artifacts));
  const log = path.join(dir, 'log');
  await writeFile(log, '');
  await writeFile(path.join(bin, 'aws'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 's3api') {
  console.log(process.env.TEST_EXISTING ? 'cli/0.1.0/SHA256SUMS' : '');
} else if (args[2].startsWith('s3://')) {
  fs.writeFileSync(args[3], process.env.TEST_EXISTING);
} else {
  if (process.env.TEST_FAIL && args[3].endsWith(process.env.TEST_FAIL)) process.exit(1);
  if (!fs.existsSync(args[2])) process.exit(2);
}
`, { mode: 0o755 });
  return {
    manifest,
    corrupt: () => writeFile(path.join(out, 'aap-linux-amd64'), 'corrupt'),
    run: () => exec('sh', [publisher, '0.1.0', out], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, R2_ACCOUNT_ID: 'test-account', R2_PUBLIC_BUCKET: 'test-bucket', TEST_LOG: log, TEST_EXISTING: existing === 'matching' ? manifest : existing, TEST_FAIL: fail } }),
    uploads: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(args => args[0] === 's3' && !args[2].startsWith('s3://')),
  };
}

test('publishes the latest pointer only after every artifact and checksum', async t => {
  const f = await fixture(t);
  await f.run();
  const uploads = await f.uploads();
  assert.equal(uploads.length, 8);
  assert.equal(uploads.at(-1)[3], 's3://test-bucket/cli/latest/version');
  assert.equal(uploads[5][3], 's3://test-bucket/cli/0.1.0/SHA256SUMS');
  assert.ok(uploads.slice(0, 6).every(args => args.includes('public, max-age=31536000, immutable')));
  assert.ok(uploads.at(-1).includes('no-cache'));
});
test('failed artifact upload never advances latest', async t => {
  const f = await fixture(t, { fail: 'aap-linux-arm64' });
  await assert.rejects(f.run());
  assert.ok((await f.uploads()).every(args => !args[3].includes('/latest/')));
});
test('refuses to overwrite a published release with different checksums', async t => {
  const f = await fixture(t, { existing: 'other checksums\n' });
  await assert.rejects(f.run(), /refusing to replace/);
  assert.deepEqual(await f.uploads(), []);
});
test('allows retrying an identical published release', async t => {
  const f = await fixture(t, { existing: 'matching' });
  await f.run();
  assert.equal((await f.uploads()).at(-1)[3], 's3://test-bucket/cli/latest/version');
});
test('rejects a corrupted local artifact before uploading', async t => {
  const f = await fixture(t);
  await f.corrupt();
  await assert.rejects(f.run());
  assert.deepEqual(await f.uploads(), []);
});
