import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { CloudInitError, PROVISION_PATH, renderProvisionEnv } from '../src/cloudInit.ts';
import { MAX_POST_INSTALL_BYTES, renderPostInstallScript, type PostInstallInput } from '../src/bootstrap.ts';

const script = readFileSync(new URL('../deploy/provision.sh', import.meta.url), 'utf8');
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl admin@example.com';
const base: PostInstallInput = { adminPublicKeys: [KEY], serverRef: '0123456789abcdef0123456789abcdef01234567', provisionScript: script };

function heredoc(out: string, tag: string): string {
  const m = new RegExp(`<<'${tag}'[^\\n]*\\n([\\s\\S]*?)\\n${tag}\\n`).exec(out);
  assert.ok(m, `${tag} block`);
  return m[1]!;
}

test('the script is bash, wrapped in main, and runs provision then next-steps', () => {
  const out = renderPostInstallScript(base);
  assert.ok(out.startsWith('#!/usr/bin/env bash\n'));
  assert.equal(spawnSync('bash', ['-n'], { input: out }).status, 0);
  assert.match(out, /^main\(\) \{$/m);
  assert.ok(out.trimEnd().endsWith('\nmain "$@"'));
  const calls = [...out.matchAll(/^ {2}(\/usr\/local\/sbin\/coxia-provision) (provision|next-steps) < \/dev\/null$/gm)].map((m) => m[2]);
  assert.deepEqual(calls, ['provision', 'next-steps']);
  assert.ok(out.includes(`${PROVISION_PATH} provision`));
});

test('it writes the same settings as install.sh and cloud-init, the keys and the exact provision.sh', () => {
  const input: PostInstallInput = { ...base, adminUser: 'ops', coxiaRef: 'v1.0.0', swapMb: 2048, timezone: 'Etc/UTC' };
  const out = renderPostInstallScript(input);
  assert.equal(heredoc(out, 'COXIA_SETTINGS_EOF') + '\n', renderProvisionEnv(input));
  assert.equal(heredoc(out, 'COXIA_KEYS_EOF'), KEY);
  const b64 = heredoc(out, 'COXIA_SCRIPT_EOF').replace(/\n/g, '');
  assert.equal(gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'), script);
});

test('it is under the provider limit and holds no secret', () => {
  const out = renderPostInstallScript({ ...base, swapMb: 1024 });
  assert.ok(Buffer.byteLength(out) < MAX_POST_INSTALL_BYTES);
  assert.ok(Buffer.byteLength(out) < 16 * 1024, 'in practice it is small');
  assert.doesNotMatch(out, /PRIVATE KEY/);
  assert.doesNotMatch(out, /\b[0-9a-f]{64}\b/);
  assert.doesNotMatch(out, /master\.key/i);
  assert.doesNotMatch(out, /(token|password|passwd)\s*=/i);
});

test('the size limit is enforced', () => {
  // Random bytes do not compress, so the embedded script really is this big.
  const big = `#!/bin/sh\n# ${randomBytes(48_000).toString('hex')}`;
  assert.throws(() => renderPostInstallScript({ ...base, provisionScript: big }), (e) => e instanceof CloudInitError && /bytes/.test(e.message));
});

test('hardening needs a key; without hardening it does not, and HARDEN=0 travels', () => {
  assert.throws(() => renderPostInstallScript({ ...base, adminPublicKeys: [] }), /public key is needed/);
  assert.throws(() => renderPostInstallScript({ ...base, adminPublicKeys: undefined }), /public key is needed/);
  const open = renderPostInstallScript({ ...base, adminPublicKeys: undefined, harden: false });
  assert.match(heredoc(open, 'COXIA_SETTINGS_EOF'), /^HARDEN=0$/m);
  assert.doesNotMatch(open, /COXIA_KEYS_EOF/);
});

test('bad input is refused', () => {
  const bad = (patch: Partial<PostInstallInput>, re: RegExp) => assert.throws(() => renderPostInstallScript({ ...base, ...patch }), (e) => e instanceof CloudInitError && re.test(e.message));
  bad({ adminPublicKeys: ['-----BEGIN OPENSSH ' + 'PRIVATE KEY-----'] }, /private key/);
  bad({ adminPublicKeys: [`${KEY}\nCOXIA_KEYS_EOF\nrm -rf /`] }, /single-line/);
  bad({ serverRef: 'x; reboot' }, /serverRef/);
  bad({ adminUser: 'root' }, /adminUser/);
  bad({ timezone: 'UTC\nHARDEN=0' }, /timezone/);
  bad({ provisionScript: 'echo hi' }, /script/);
});
