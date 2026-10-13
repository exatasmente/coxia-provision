// provision.sh with its paths pointed at a throwaway folder: only the subcommands that read, which is all the sandbox mode allows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../deploy/provision.sh', import.meta.url).pathname;
const KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

function box(key: string | null = KEY) {
  const root = mkdtempSync(join(tmpdir(), 'coxia-provision-test-'));
  const ssh = join(root, 'ssh');
  mkdirSync(ssh);
  const keyFile = join(root, 'master.key');
  if (key !== null) writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  const env = { PATH: process.env['PATH'] ?? '', COXIA_PROVISION_SANDBOX: '1', COXIA_PROVISION_STATE_DIR: join(root, 'state'), COXIA_PROVISION_KEY_FILE: keyFile, COXIA_PROVISION_SSH_DIR: ssh };
  const run = (...args: string[]) => spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' });
  return { root, ssh, run, marker: join(root, 'state', 'recovery-copy-handed-over') };
}

test('recovery-copy prints the key once, on stdout only, and then refuses', () => {
  const b = box();
  const first = b.run('recovery-copy');
  assert.equal(first.status, 0);
  assert.equal(first.stdout, `${KEY}\n`);
  assert.equal(first.stderr, '');
  assert.ok(existsSync(b.marker));
  assert.equal(statSync(b.marker).mode & 0o777, 0o600);
  assert.ok(!readFileSync(b.marker, 'utf8').includes(KEY));

  const second = b.run('recovery-copy');
  assert.equal(second.status, 3);
  assert.equal(second.stdout, '');
  assert.ok(!second.stderr.includes(KEY));
});

test('recovery-copy with no key or a malformed key fails and leaves no marker', () => {
  const none = box(null);
  assert.equal(none.run('recovery-copy').status, 4);
  assert.ok(!existsSync(none.marker));
  const bad = box('short');
  const r = bad.run('recovery-copy');
  assert.equal(r.status, 4);
  assert.ok(!r.stdout.includes('short'));
  assert.ok(!existsSync(bad.marker));
});

test('host-keys prints a fingerprint per key', () => {
  const b = box();
  assert.equal(b.run('host-keys').status, 1, 'no keys yet');
  const gen = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(b.ssh, 'ssh_host_ed25519_key')]);
  assert.equal(gen.status, 0);
  const r = b.run('host-keys');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ed25519 SHA256:[A-Za-z0-9+/]{43}\n$/);
});

test('provision does not run in sandbox mode, and an unknown command is a usage error', () => {
  const b = box();
  const p = b.run('provision');
  assert.equal(p.status, 1);
  assert.match(p.stderr, /sandbox/);
  assert.equal(b.run('nope').status, 2);
});

test('the script parses', () => {
  assert.equal(spawnSync('bash', ['-n', SCRIPT]).status, 0);
});
