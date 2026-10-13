import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { CloudInitError, MAX_USER_DATA_BYTES, PROVISION_PATH, SSHD_HARDENING, renderCloudInit, type CloudInitInput } from '../src/cloudInit.ts';

const script = readFileSync(new URL('../deploy/provision.sh', import.meta.url), 'utf8');
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl admin@example.com';
const REF = '0123456789abcdef0123456789abcdef01234567';
const base: CloudInitInput = { adminPublicKeys: [KEY], serverRef: REF, provisionScript: script, timezone: 'Etc/UTC' };

test('the output is a cloud-config with the user, the key, the pinned ref and the run', () => {
  const out = renderCloudInit({ ...base, swapMb: 2048, coxiaRef: 'v1.0.0' });
  assert.ok(out.startsWith('#cloud-config\n'));
  assert.ok(out.endsWith('\n'));
  assert.match(out, /^ {2}- name: "admin"$/m);
  assert.match(out, /^ {6}- "ssh-ed25519 AAAA[^"]+ admin@example\.com"$/m);
  assert.match(out, /^disable_root: true$/m);
  assert.match(out, /^ssh_pwauth: false$/m);
  assert.match(out, /^timezone: "Etc\/UTC"$/m);
  assert.match(out, /^ {6}COXIA_SERVER_REF=0123456789abcdef0123456789abcdef01234567$/m);
  assert.match(out, /^ {6}COXIA_REF=v1\.0\.0$/m);
  assert.match(out, /^ {6}SWAP_MB=2048$/m);
  assert.match(out, /^ {6}AllowUsers admin$/m);
  assert.match(out, new RegExp(`^ {2}- \\["${PROVISION_PATH}", "provision"\\]$`, 'm'));
});

test('rendering is deterministic', () => {
  assert.equal(renderCloudInit(base), renderCloudInit({ ...base }));
});

test('the embedded script is exactly provision.sh', () => {
  const out = renderCloudInit(base);
  const m = /encoding: gz\+b64\n {4}content: "([A-Za-z0-9+/=]+)"/.exec(out);
  assert.ok(m, 'script block present');
  assert.equal(gunzipSync(Buffer.from(m[1]!, 'base64')).toString('utf8'), script);
});

test('user-data holds no secret and stays under the provider limit', () => {
  const out = renderCloudInit({ ...base, swapMb: 1024 });
  assert.ok(Buffer.byteLength(out) <= MAX_USER_DATA_BYTES);
  assert.doesNotMatch(out, /PRIVATE KEY/);
  assert.doesNotMatch(out, /\b[0-9a-f]{64}\b/);
  assert.doesNotMatch(out, /master/i);
  assert.doesNotMatch(out, /^\s*(passwd|plain_text_passwd|chpasswd):/m);
});

test('the sshd drop-in matches the one provision.sh writes', () => {
  const out = renderCloudInit(base);
  for (const line of SSHD_HARDENING) {
    assert.ok(out.includes(`      ${line}\n`), `cloud-init has ${line}`);
    assert.ok(script.includes(`\n${line}\n`), `provision.sh has ${line}`);
  }
});

test('optional settings fall back: no swap, no coxia ref, default user', () => {
  const out = renderCloudInit(base);
  assert.match(out, /SWAP_MB=0$/m);
  assert.doesNotMatch(out, /COXIA_REF=/);
  const custom = renderCloudInit({ ...base, adminUser: 'ops' });
  assert.match(custom, /name: "ops"/);
  assert.match(custom, /AllowUsers ops/);
});

test('several keys keep their order', () => {
  const second = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 second@example.com';
  const out = renderCloudInit({ ...base, adminPublicKeys: [KEY, second] });
  assert.ok(out.indexOf(KEY) < out.indexOf(second));
});

test('bad input is refused', () => {
  const bad = (patch: Partial<CloudInitInput>, re: RegExp) => assert.throws(() => renderCloudInit({ ...base, ...patch }), (e) => e instanceof CloudInitError && re.test(e.message));
  bad({ adminPublicKeys: [] }, /public key is needed/);
  bad({ adminPublicKeys: ['-----BEGIN OPENSSH ' + 'PRIVATE KEY-----'] }, /private key/);
  bad({ adminPublicKeys: [`${KEY}\nruncmd: evil`] }, /single-line/);
  bad({ adminPublicKeys: ['not a key'] }, /single-line/);
  bad({ serverRef: 'main; rm -rf /' }, /serverRef/);
  bad({ serverRef: '--upload-pack=x' }, /serverRef/);
  bad({ timezone: 'UTC\nfoo: bar' }, /timezone/);
  bad({ swapMb: -1 }, /swapMb/);
  bad({ swapMb: 1.5 }, /swapMb/);
  bad({ adminUser: 'root' }, /adminUser/);
  bad({ serverRepoUrl: 'http://example.com/x.git' }, /https/);
  bad({ provisionScript: 'echo hi' }, /script/);
  bad({ provisionScript: `#!/bin/sh\n${'x'.repeat(40_000).split('').map((_, i) => String(i * 7919 % 10007)).join('')}` }, /bytes/);
});
