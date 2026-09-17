import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const installer = fileURLToPath(new URL('./install.sh', import.meta.url));

async function fixture(t, { version = '0.1.0', checksum = 'valid', os = 'Linux', arch = 'x86_64', missingBinary = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aap installer '));
  const target = path.join(dir, 'install dir');
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo '${os}' ;; -m) echo '${arch}' ;; esac\n`, { mode: 0o755 });
  const binary = '#!/bin/sh\nprintf "aap 0.1.0\\n"\n';
  const hash = createHash('sha256').update(binary).digest('hex');
  const file = `aap-${os === 'Darwin' ? 'darwin' : 'linux'}-${['arm64', 'aarch64'].includes(arch) ? 'arm64' : 'amd64'}`;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/cli/latest/version') res.end(`${version}\n`);
    else if (req.url === `/cli/0.1.0/${file}` && !missingBinary) res.end(binary);
    else if (req.url === '/cli/0.1.0/SHA256SUMS') {
      const row = `${checksum === 'wrong' ? '0'.repeat(64) : hash}  ${file}\n`;
      res.end(checksum === 'duplicate' ? row + row : row);
    } else { res.statusCode = 404; res.end('not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const env = { ...process.env, HOME: dir, TMPDIR: dir, PATH: `${bin}:${process.env.PATH}`, AAP_CLI_BASE: `http://127.0.0.1:${server.address().port}`, AAP_INSTALL_DIR: target, AAP_CLI_VERSION: 'latest' };
  return { target, requests, binary, run: (overrides = {}) => exec('sh', [installer], { env: { ...env, ...overrides } }) };
}

for (const [os, arch] of [['Darwin', 'x86_64'], ['Darwin', 'arm64'], ['Linux', 'amd64'], ['Linux', 'aarch64']]) {
  test(`installs ${os}/${arch} from a pinned latest version, including paths with spaces`, async t => {
    const f = await fixture(t, { os, arch });
    const { stdout } = await f.run();
    assert.equal(stdout, 'aap 0.1.0\n');
    assert.equal(await readFile(path.join(f.target, 'aap'), 'utf8'), f.binary);
    assert.equal((await stat(path.join(f.target, 'aap'))).mode & 0o777, 0o755);
    assert.equal(f.requests[0], '/cli/latest/version');
    assert.ok(f.requests.slice(1).every(url => url.startsWith('/cli/0.1.0/')));
    await f.run({ AAP_CLI_VERSION: '0.1.0' });
    assert.equal(f.requests.filter(url => url === '/cli/latest/version').length, 1);
  });
}
for (const checksum of ['wrong', 'duplicate']) {
  test(`${checksum} checksum preserves an existing installation`, async t => {
    const f = await fixture(t, { checksum });
    await mkdir(f.target);
    await writeFile(path.join(f.target, 'aap'), 'existing');
    await assert.rejects(f.run(), /checksum/i);
    assert.equal(await readFile(path.join(f.target, 'aap'), 'utf8'), 'existing');
  });
}
test('missing download leaves the installed binary untouched', async t => {
  const f = await fixture(t, { missingBinary: true });
  await mkdir(f.target);
  await writeFile(path.join(f.target, 'aap'), 'existing');
  await assert.rejects(f.run());
  assert.equal(await readFile(path.join(f.target, 'aap'), 'utf8'), 'existing');
});
for (const version of ['../bad', '0.1.0\n../bad', 'v0.1.0']) {
  test(`rejects invalid version ${JSON.stringify(version)}`, async t => {
    const f = await fixture(t, { version });
    await assert.rejects(f.run(), /invalid release version/);
    assert.deepEqual(f.requests, ['/cli/latest/version']);
  });
}
test('unsupported runtime is rejected before downloading', async t => {
  const f = await fixture(t, { os: 'Windows' });
  await assert.rejects(f.run(), /supported operating systems/);
  assert.deepEqual(f.requests, []);
});
