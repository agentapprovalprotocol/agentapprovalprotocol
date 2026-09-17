import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
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
  const env = { ...process.env, HOME: dir, TMPDIR: dir, SHELL: '/bin/bash', ZDOTDIR: '', XDG_CONFIG_HOME: '', AAP_NO_MODIFY_PATH: '', PATH: `${bin}:${process.env.PATH}`, AAP_CLI_BASE: `http://127.0.0.1:${server.address().port}`, AAP_INSTALL_DIR: target, AAP_CLI_VERSION: 'latest' };
  return { dir, env, target, requests, binary, run: (overrides = {}) => exec('sh', [installer], { env: { ...env, ...overrides } }) };
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
    await assert.rejects(stat(path.join(f.dir, '.bashrc')), { code: 'ENOENT' });
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

test('default install configures Zsh once and makes aap available after reloading', async t => {
  const f = await fixture(t);
  const env = { AAP_INSTALL_DIR: '', SHELL: '/bin/zsh' };
  const profile = path.join(f.dir, '.zshrc');
  await writeFile(profile, '# existing configuration without a final newline');
  const { stderr } = await f.run(env);
  assert.match(stderr, /Restart your terminal/);
  const contents = await readFile(profile, 'utf8');
  assert.ok(contents.startsWith('# existing configuration without a final newline\n'));
  await f.run(env);
  assert.equal(await readFile(profile, 'utf8'), contents);
  const { stdout } = await exec('sh', ['-c', '. "$1"; . "$1"; command -v aap; aap version; printf "%s\\n" "$PATH"', 'test', profile], { env: f.env });
  const target = path.join(f.dir, '.local/bin');
  const [executable, version, shellPath] = stdout.trim().split('\n');
  assert.equal(executable, path.join(target, 'aap'));
  assert.equal(version, 'aap 0.1.0');
  assert.equal(shellPath.split(':').filter(entry => entry === target).length, 1);
});

test('Zsh respects ZDOTDIR and safely quotes custom installation paths', async t => {
  const f = await fixture(t);
  const target = path.join(f.dir, "quote ' dollar $HOME backslash \\ `false` $(false)");
  const zdotdir = path.join(f.dir, 'zsh config');
  const { stderr } = await f.run({ AAP_INSTALL_DIR: target, SHELL: '/usr/bin/zsh', ZDOTDIR: zdotdir });
  const profile = path.join(zdotdir, '.zshrc');
  const { stdout } = await exec('sh', ['-uc', '. "$1"; command -v aap', 'test', profile], { env: f.env });
  assert.equal(stdout.trim(), path.join(target, 'aap'));
  // The command shown for the current terminal must work without reloading files.
  const command = stderr.trim().split('\n').at(-1).trim();
  const immediate = await exec('sh', ['-uc', `${command}; command -v aap`], { env: f.env });
  assert.equal(immediate.stdout.trim(), path.join(target, 'aap'));
  await assert.rejects(stat(path.join(f.dir, '.zshrc')), { code: 'ENOENT' });
});

for (const login of ['.bash_profile', '.bash_login', '.profile']) {
  test(`Bash configures interactive shells and the existing ${login} without masking it`, async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.dir, login), '# keep this profile\n');
    const { stderr } = await f.run();
    assert.match(stderr, /Restart your terminal/);
    for (const name of ['.bashrc', login]) {
      const profile = path.join(f.dir, name);
      const contents = await readFile(profile, 'utf8');
      await f.run();
      assert.equal(await readFile(profile, 'utf8'), contents);
      const { stdout } = await exec('bash', ['--noprofile', '--norc', '-c', '. "$1"; aap version', 'test', profile], { env: f.env });
      assert.equal(stdout, 'aap 0.1.0\n');
    }
    assert.deepEqual((await readdir(f.dir)).filter(name => ['.bash_profile', '.bash_login', '.profile'].includes(name)), [login]);
  });
}

test('Fish respects XDG_CONFIG_HOME and preserves existing configuration on reruns', async t => {
  const f = await fixture(t);
  const config = path.join(f.dir, 'fish config');
  const profile = path.join(config, 'fish/config.fish');
  await mkdir(path.dirname(profile), { recursive: true });
  await writeFile(profile, '# existing fish settings\n');
  const env = { SHELL: '/usr/bin/fish', XDG_CONFIG_HOME: config };
  const { stderr } = await f.run(env);
  assert.match(stderr, /Restart your terminal/);
  assert.match(stderr, /set -gx PATH/);
  const contents = await readFile(profile, 'utf8');
  assert.ok(contents.startsWith('# existing fish settings\n'));
  await f.run(env);
  assert.equal(await readFile(profile, 'utf8'), contents);
  await assert.rejects(stat(path.join(f.dir, '.profile')), { code: 'ENOENT' });
});

for (const reason of ['already on PATH', 'opted out', 'unknown shell', 'empty shell']) {
  test(`${reason} leaves shell startup files unchanged`, async t => {
    const f = await fixture(t);
    const profile = path.join(f.dir, '.bashrc');
    await writeFile(profile, '# unchanged\n');
    const overrides = {
      'already on PATH': { PATH: `${f.target}:${f.env.PATH}` },
      'opted out': { AAP_NO_MODIFY_PATH: '1' },
      'unknown shell': { SHELL: '/bin/tcsh' },
      'empty shell': { SHELL: '' },
    }[reason];
    const { stdout, stderr } = await f.run(overrides);
    assert.equal(stdout, 'aap 0.1.0\n');
    assert.equal(await readFile(profile, 'utf8'), '# unchanged\n');
    await assert.rejects(stat(path.join(f.dir, '.profile')), { code: 'ENOENT' });
    assert.doesNotMatch(stderr, /Restart your terminal/);
    if (reason === 'already on PATH') assert.doesNotMatch(stderr, /export PATH/);
    else if (reason === 'opted out') assert.match(stderr, /export PATH/);
    else assert.match(stderr, /Automatic PATH setup supports Bash, Zsh and Fish/);
  });
}

test('a shell configuration write failure keeps the working installation and prints manual setup', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.dir, '.zshrc'));
  const { stdout, stderr } = await f.run({ SHELL: '/bin/zsh' });
  assert.equal(stdout, 'aap 0.1.0\n');
  assert.equal(await readFile(path.join(f.target, 'aap'), 'utf8'), f.binary);
  assert.match(stderr, /Could not update/);
  assert.match(stderr, /export PATH/);
  assert.doesNotMatch(stderr, /Restart your terminal/);
});

for (const shell of ['zsh', 'fish']) {
  test(`generated configuration works in ${shell} with literal special characters in the path`, { skip: spawnSync(shell, ['--version']).error?.code === 'ENOENT' }, async t => {
    const f = await fixture(t);
    const target = path.join(f.dir, "quote ' dollar $HOME backslash \\ `false` $(false)");
    const { stderr } = await f.run({ AAP_INSTALL_DIR: target, SHELL: `/bin/${shell}` });
    const profile = path.join(f.dir, shell === 'zsh' ? '.zshrc' : '.config/fish/config.fish');
    const args = shell === 'zsh'
      ? ['-dfc', '. "$1"; . "$1"; command -v aap; aap version; printf "%s\\n" "$PATH"', 'test', profile]
      : ['--no-config', '-c', 'source "$argv[1]"; source "$argv[1]"; command -s aap; aap version; string join : $PATH', profile];
    const { stdout } = await exec(shell, args, { env: f.env });
    const [executable, version, shellPath] = stdout.trim().split('\n');
    assert.equal(executable, path.join(target, 'aap'));
    assert.equal(version, 'aap 0.1.0');
    assert.equal(shellPath.split(':').filter(entry => entry === target).length, 1);
    const command = stderr.trim().split('\n').at(-1).trim();
    const immediate = await exec(shell, [shell === 'zsh' ? '-dfc' : '--no-config', ...(shell === 'fish' ? ['-c'] : []), `${command}; aap version`], { env: f.env });
    assert.equal(immediate.stdout, 'aap 0.1.0\n');
  });
}
