// setup_admin exactly as written in deploy/provision.sh, run against stubbed system commands. What it asks of useradd is the point:
// Ubuntu already has a group called `admin`, and useradd refuses to make a second group of the same name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = readFileSync(new URL('../deploy/provision.sh', import.meta.url), 'utf8');
const START = SCRIPT.indexOf('\nsetup_admin() {') + 1;
const SETUP_ADMIN = SCRIPT.slice(START, SCRIPT.indexOf('\n}\n', START) + 3);
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE0 test@example.com';

const STUBS: Record<string, string> = {
  // The user does not exist until useradd has run.
  id: 'if [ "$1" = -gn ]; then echo "$STUB_PRIMARY_GROUP"; elif [ -e "$ROOT/created" ]; then exit 0; else exit 1; fi',
  getent: 'case "$1" in group) [ "$STUB_GROUP_EXISTS" = 1 ] ;; passwd) echo "$2:x:1001:1001::$ROOT/home/$2:/bin/bash" ;; esac',
  useradd: 'printf "%s\\n" "$*" >> "$ROOT/useradd.log"; touch "$ROOT/created"',
  passwd: 'exit 0',
  visudo: 'exit 0',
  chown: 'exit 0',
  chmod: 'exit 0',
  install: 'for last; do :; done; if [ "$1" = -d ] || [ "${*#*-d }" != "$*" ]; then mkdir -p "$last"; else : > "$last"; fi',
};

function run(groupExists: boolean, times = 1) {
  const root = mkdtempSync(join(tmpdir(), 'coxia-admin-test-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'sudoers'));
  mkdirSync(join(root, 'home', 'admin'), { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const keys = join(root, 'admin-keys');
  writeFileSync(keys, `${KEY}\n`);
  const harness = [
    'set -euo pipefail',
    `ADMIN_USER=admin; ADMIN_KEYS_FILE=${keys}; SUDOERS_DIR=${join(root, 'sudoers')}`,
    'say() { :; }',
    'die() { echo "die: $*" >&2; exit 1; }',
    'write_file() { cat > "$1"; }',
    SETUP_ADMIN,
    ...Array<string>(times).fill('setup_admin'),
  ].join('\n');
  const env = { PATH: `${bin}:${process.env['PATH'] ?? ''}`, ROOT: root, STUB_GROUP_EXISTS: groupExists ? '1' : '0', STUB_PRIMARY_GROUP: 'admin' };
  const res = spawnSync('bash', ['-c', harness], { env, encoding: 'utf8' });
  let useradd = '';
  try {
    useradd = readFileSync(join(root, 'useradd.log'), 'utf8');
  } catch {
    // useradd never ran
  }
  return { res, useradd, authorizedKeys: join(root, 'home', 'admin', '.ssh', 'authorized_keys') };
}

test('setup_admin was found in provision.sh', () => {
  assert.ok(START > 0 && SETUP_ADMIN.startsWith('setup_admin() {') && SETUP_ADMIN.endsWith('}\n'));
});

test('a group already named like the user becomes its primary group instead of failing useradd', () => {
  const { res, useradd } = run(true);
  assert.equal(res.status, 0, res.stderr);
  assert.match(useradd, /--gid admin\b/);
  assert.doesNotMatch(useradd, /--user-group/);
  assert.match(useradd, /--groups sudo\b/);
});

test('with no group of that name the user gets its own', () => {
  const { res, useradd } = run(false);
  assert.equal(res.status, 0, res.stderr);
  assert.match(useradd, /--user-group/);
  assert.doesNotMatch(useradd, /--gid/);
});

test('the key lands in authorized_keys once, even when the step runs twice', () => {
  const twice = run(true, 2);
  assert.equal(twice.res.status, 0, twice.res.stderr);
  const body = readFileSync(twice.authorizedKeys, 'utf8');
  assert.equal(body.split('\n').filter((l) => l === KEY).length, 1);
  assert.equal(twice.useradd.trim().split('\n').length, 1, 'the second run finds the user and does not add it again');
});
