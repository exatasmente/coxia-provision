// install.sh run end to end in its sandbox mode: a throwaway root, stubbed git/apt-get/id/getent/curl on PATH, an os-release file and a
// "terminal" file. The stub git hands out a stub provision.sh, so nothing is fetched and nothing real is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderProvisionEnv } from '../src/cloudInit.ts';

const INSTALL = new URL('../install.sh', import.meta.url).pathname;
const STAMP = new URL('../scripts/stamp-release.sh', import.meta.url).pathname;
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl admin@example.com';
const KEY2 = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 second@example.com';
const UBUNTU = 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n';

function stub(dir: string, name: string, body: string): void {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
}

function box(opts: { osRelease?: string; tty?: string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coxia-install-test-'));
  const bin = join(root, 'bin');
  const sandbox = join(root, 'fs');
  mkdirSync(bin);
  mkdirSync(sandbox);
  const log = join(root, 'calls.log');
  const home = join(root, 'home-admin');
  const osFile = join(root, 'os-release');
  const tty = join(root, 'tty');
  writeFileSync(osFile, opts.osRelease ?? UBUNTU);
  if (opts.tty !== null) writeFileSync(tty, opts.tty ?? 'y\n');
  // The provision.sh the fake checkout contains: records how it was called and prints what the real one would.
  const provision = join(root, 'provision-stub.sh');
  writeFileSync(provision, `#!/bin/bash\necho "provision.sh $*" >> "${log}"\n[ "$1" != host-keys ] || echo "ed25519 SHA256:${'A'.repeat(43)}"\n`);
  stub(bin, 'git', `
if [ "$1" = -C ]; then dir="$2"; shift 2; fi
echo "git $* GIT_TERMINAL_PROMPT=\${GIT_TERMINAL_PROMPT:-} stdin_closed=$([ -t 0 ] && echo no || echo yes)" >> "${log}"
case "$1" in
  init) mkdir -p "\${2:?}/.git" ;;
  checkout) mkdir -p "$dir/deploy"; cp "${provision}" "$dir/deploy/provision.sh"; chmod +x "$dir/deploy/provision.sh" ;;
  rev-parse) echo 0123456789abcdef0123456789abcdef01234567 ;;
esac
exit 0`);
  stub(bin, 'curl', `echo "curl $*" >> "${log}"; exit 22`);
  stub(bin, 'apt-get', `echo "apt-get $*" >> "${log}"`);
  stub(bin, 'id', `if [ "$1" = -u ]; then echo "\${STUB_UID:-0}"; else exec /usr/bin/id "$@"; fi`);
  stub(bin, 'getent', `if [ "$1 $2" = "passwd admin" ] && [ -n "\${STUB_ADMIN_HOME:-}" ]; then echo "admin:x:1000:1000::$STUB_ADMIN_HOME:/bin/bash"; else exit 2; fi`);
  const env = (extra: Record<string, string> = {}) => ({
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    COXIA_INSTALL_SANDBOX: '1',
    COXIA_INSTALL_ROOT: sandbox,
    COXIA_INSTALL_OS_RELEASE: osFile,
    COXIA_INSTALL_TTY: tty,
    ...extra,
  });
  // Fed on standard input, the way `curl | sudo bash -s --` does.
  const run = (args: string[], extra: Record<string, string> = {}, script = INSTALL) =>
    spawnSync('bash', ['-s', '--', ...args], { env: env(extra), input: readFileSync(script), encoding: 'utf8' });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { root, sandbox, home, run, calls, env, tty, envFile: join(sandbox, 'etc/coxia-provision.env'), keysFile: join(sandbox, 'etc/coxia-provision.admin-keys') };
}

const REQUIRED = ['--server-ref', 'v0.1.0', '--admin-key', KEY, '--yes'];

test('a full run fetches provision at the ref, writes the settings and runs provision then next-steps', () => {
  const b = box();
  const r = b.run(['--ref', 'v1.2.3', ...REQUIRED, '--coxia-ref', 'v1.0.0', '--admin-key', KEY2, '--admin-user', 'ops', '--swap', '2G', '--timezone', 'Etc/UTC']);
  assert.equal(r.status, 0, r.stderr);
  const calls = b.calls();
  assert.ok(calls.some((c) => c.startsWith('git init -q ') && c.includes('/opt/coxia-provision/v1.2.3')));
  assert.ok(calls.some((c) => c.includes('remote add origin https://github.com/exatasmente/coxia-provision.git')));
  assert.ok(calls.some((c) => c.includes('fetch -q --depth 1 origin v1.2.3')));
  assert.ok(calls.every((c) => !c.startsWith('git') || c.includes('GIT_TERMINAL_PROMPT=0')), 'git never asks for a credential');
  assert.ok(calls.every((c) => !c.startsWith('curl')), 'no network in this path besides git');
  assert.deepEqual(calls.filter((c) => c.startsWith('provision.sh')), ['provision.sh provision', 'provision.sh next-steps']);
  assert.equal(
    readFileSync(b.envFile, 'utf8'),
    renderProvisionEnv({ adminUser: 'ops', serverRef: 'v0.1.0', coxiaRef: 'v1.0.0', swapMb: 2048, timezone: 'Etc/UTC' }),
    'the bash and the TypeScript writers agree',
  );
  assert.equal(readFileSync(b.keysFile, 'utf8'), `${KEY}\n${KEY2}\n`);
  assert.equal(statSync(join(b.sandbox, 'usr/local/sbin/coxia-provision')).mode & 0o777, 0o755);
  assert.match(r.stdout, /hardening +ssh lockdown \+ firewall/);
});

test('the default ref is main and says it is not pinned; a stamped file uses its tag silently', () => {
  const plain = box();
  const r = plain.run(REQUIRED);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /coxia-provision ref is not pinned/);
  assert.ok(plain.calls().some((c) => c.includes('fetch -q --depth 1 origin main')));

  const b = box();
  const stamped = join(b.root, 'install-stamped.sh');
  copyFileSync(INSTALL, stamped);
  const st = spawnSync('bash', [STAMP, 'v1.2.3', '--server-ref', 'v0.4.0', '--file', stamped], { encoding: 'utf8' });
  assert.equal(st.status, 0, st.stderr);
  assert.match(readFileSync(stamped, 'utf8'), /^PINNED_REF="v1\.2\.3"$/m);
  const ok = b.run(['--admin-key', KEY, '--yes'], {}, stamped);
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stderr, /not pinned/);
  assert.ok(b.calls().some((c) => c.includes('fetch -q --depth 1 origin v1.2.3')));
  assert.match(readFileSync(b.envFile, 'utf8'), /^COXIA_SERVER_REF=v0\.4\.0$/m);
  // --ref still wins over the stamp.
  const over = box();
  over.run(['--ref', 'v9.9.9', '--admin-key', KEY, '--yes'], {}, stamped);
  assert.ok(over.calls().some((c) => c.includes('origin v9.9.9')));
});

test('stamp-release refuses a tag that could break the quoting and is a no-op the second time', () => {
  const b = box();
  const f = join(b.root, 'i.sh');
  copyFileSync(INSTALL, f);
  assert.notEqual(spawnSync('bash', [STAMP, 'v1";rm -rf /;"', '--file', f]).status, 0);
  assert.notEqual(spawnSync('bash', [STAMP, 'main', '--file', f]).status, 0);
  assert.equal(readFileSync(f, 'utf8'), readFileSync(INSTALL, 'utf8'));
  assert.equal(spawnSync('bash', [STAMP, 'v1.0.0', '--file', f]).status, 0);
  const once = readFileSync(f, 'utf8');
  assert.equal(spawnSync('bash', [STAMP, 'v1.0.0', '--file', f]).status, 0);
  assert.equal(readFileSync(f, 'utf8'), once);
  assert.equal(spawnSync('bash', ['-n', f]).status, 0);
  assert.ok((statSync(f).mode & 0o111) !== 0, 'stays executable');
});

test('--no-harden passes through as HARDEN=0 with a loud warning, and needs no key', () => {
  const b = box();
  const r = b.run(['--no-harden', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING: --no-harden: sshd is NOT locked down and the firewall is NOT enabled/);
  assert.match(readFileSync(b.envFile, 'utf8'), /^HARDEN=0$/m);
  assert.ok(!existsSync(b.keysFile));
  const hardened = box();
  hardened.run(REQUIRED);
  assert.doesNotMatch(readFileSync(hardened.envFile, 'utf8'), /HARDEN/);
});

test('hardening without any admin key is refused before anything is touched', () => {
  const b = box();
  const r = b.run(['--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to lock root out/);
  assert.match(r.stderr, /--admin-key/);
  assert.deepEqual(b.calls(), []);
  assert.deepEqual(readdirSync(b.sandbox), []);

  // An admin user that already has a key is enough.
  const ssh = join(b.home, '.ssh');
  mkdirSync(ssh, { recursive: true });
  writeFileSync(join(ssh, 'authorized_keys'), `${KEY}\n`);
  const ok = b.run(['--yes'], { STUB_ADMIN_HOME: b.home });
  assert.equal(ok.status, 0, ok.stderr);
  // ...but an empty authorized_keys is not.
  writeFileSync(join(ssh, 'authorized_keys'), '');
  assert.equal(box().run(['--yes'], { STUB_ADMIN_HOME: b.home }).status, 1);
  assert.equal(b.run(['--yes'], { STUB_ADMIN_HOME: b.home }).status, 1);
});

test('it refuses to run as a user other than root, and on anything but Ubuntu 24.04 unless --force-os', () => {
  const b = box();
  const user = b.run(REQUIRED, { STUB_UID: '1000' });
  assert.equal(user.status, 1);
  assert.match(user.stderr, /run as root/);
  assert.deepEqual(b.calls(), []);

  for (const os of ['ID=debian\nVERSION_ID="12"\n', 'ID=ubuntu\nVERSION_ID="22.04"\n', '']) {
    const o = box({ osRelease: os });
    const r = o.run(REQUIRED);
    assert.equal(r.status, 1, os);
    assert.match(r.stderr, /Ubuntu 24\.04/);
    assert.deepEqual(o.calls(), []);
    const forced = o.run([...REQUIRED, '--force-os']);
    assert.equal(forced.status, 0, forced.stderr);
  }
});

test('bad options are refused with nothing done', () => {
  const cases: [string[], RegExp][] = [
    [['--bogus'], /unknown option/],
    [['--ref'], /needs a value/],
    [['--ref', 'main; rm -rf /'], /--ref is not a plain git ref/],
    [['--ref', '--upload-pack=x'], /--ref/],
    [['--ref', 'coxia-server'], /reserved/],
    [['--server-ref', 'a..b'], /--server-ref/],
    [['--coxia-ref', 'x y'], /--coxia-ref/],
    [['--admin-user', 'root'], /cannot be root/],
    [['--admin-user', 'Bad Name'], /--admin-user/],
    [['--admin-key', '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----'], /private key/],
    [['--admin-key', 'not a key'], /public key/],
    [['--admin-key', `${KEY}\nruncmd: x`], /public key/],
    [['--swap', 'lots'], /--swap/],
    [['--swap', '999G'], /over 64G/],
    [['--timezone', 'UTC\nfoo'], /--timezone/],
  ];
  for (const [args, re] of cases) {
    const b = box();
    const r = b.run([...(args.includes('--admin-key') ? [] : ['--admin-key', KEY]), '--yes', ...args]);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, re, args.join(' '));
    assert.deepEqual(b.calls(), [], args.join(' '));
    assert.deepEqual(readdirSync(b.sandbox), [], args.join(' '));
  }
});

test('--help prints the options and needs neither root nor Ubuntu', () => {
  const b = box({ osRelease: 'ID=debian\n' });
  const r = b.run(['--help'], { STUB_UID: '1000' });
  assert.equal(r.status, 0);
  for (const o of ['--ref', '--server-ref', '--coxia-ref', '--admin-user', '--admin-key', '--no-harden', '--swap', '--timezone', '--force-os', '--yes']) {
    assert.ok(r.stdout.includes(o), o);
  }
  assert.deepEqual(b.calls(), []);
});

test('without --yes it asks on the terminal, and with no terminal it refuses', () => {
  const no = box({ tty: 'n\n' });
  const declined = no.run(['--admin-key', KEY, '--server-ref', 'v0.1.0']);
  assert.equal(declined.status, 1);
  assert.match(declined.stderr, /cancelled/);
  assert.deepEqual(no.calls(), []);

  const yes = box({ tty: 'y\n' });
  assert.equal(yes.run(['--admin-key', KEY, '--server-ref', 'v0.1.0']).status, 0);

  const none = box({ tty: null });
  const r = none.run(['--admin-key', KEY]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pass --yes/);
  assert.deepEqual(none.calls(), []);
});

test('a second run converges: the same files, untouched', () => {
  const b = box();
  const args = [...REQUIRED, '--swap', '1G', '--ref', 'v1.0.0'];
  assert.equal(b.run(args).status, 0);
  const snap = () => [b.envFile, b.keysFile, join(b.sandbox, 'usr/local/sbin/coxia-provision')].map((f) => ({ f, ino: statSync(f).ino, mtime: statSync(f).mtimeMs, body: readFileSync(f, 'utf8') }));
  const first = snap();
  const filesBefore = readdirSync(join(b.sandbox, 'etc')).sort();
  assert.equal(b.run(args).status, 0);
  assert.deepEqual(snap(), first);
  assert.deepEqual(readdirSync(join(b.sandbox, 'etc')).sort(), filesBefore, 'no temp files left behind');
  assert.equal(b.calls().filter((c) => c === 'provision.sh provision').length, 2, 'provision.sh itself is what converges the machine');
});

test('a truncated download does nothing, at any cut', () => {
  const full = readFileSync(INSTALL, 'utf8');
  const lines = full.split('\n');
  const cuts = new Set<number>();
  for (let i = 1; i < lines.length; i++) cuts.add(lines.slice(0, i).join('\n').length);
  cuts.add(Math.floor(full.length / 2));
  // Every byte of the last line, where a cut could leave a complete-looking `main`.
  const lastLine = full.lastIndexOf('\nmain ') + 1;
  for (let i = lastLine; i < full.length; i++) cuts.add(i);
  // A cut that only drops the final newline is the whole script.
  for (const c of [...cuts]) if (c >= full.trimEnd().length) cuts.delete(c);
  for (const cut of cuts) {
    const b = box();
    const part = join(b.root, 'partial.sh');
    writeFileSync(part, full.slice(0, cut));
    b.run(REQUIRED, {}, part);
    assert.deepEqual(b.calls(), [], `cut at ${cut}`);
    assert.deepEqual(readdirSync(b.sandbox), [], `cut at ${cut}`);
  }
  // The file itself, whole, does run.
  const ok = box();
  assert.equal(ok.run(REQUIRED).status, 0);
});

test('all of the body is inside main: the only top-level command is its call', () => {
  const full = readFileSync(INSTALL, 'utf8');
  assert.ok(full.trimEnd().endsWith('main "$@" --end-of-script'));
  assert.equal(full.match(/^main "/gm)?.length, 1);
  assert.equal(spawnSync('bash', ['-n', INSTALL]).status, 0);
});
