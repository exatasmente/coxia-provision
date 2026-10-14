import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { main, stateRoot, tokenResolver } from '../src/cli.ts';
import type { BuildInput, Built } from '../src/cli.ts';
import { makeWorld } from './move-world.ts';
import type { World } from './move-world.ts';

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cxp-cli-'));
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) } };
}
const worldBuild = (x: World, seen: BuildInput[] = []) => async (input: BuildInput): Promise<Built> => {
  seen.push(input);
  return { deps: { ...x.deps, movesDir: stateRoot(input.env), log: (l) => input.io.stderr(`${l}\n`) }, close: () => undefined };
};
const base = ['move', '--provider', 'fake', '--plan', 's-small', '--region', 'fsn', '--server-ref', 'v0.0.0', '--image', 'ubuntu-24.04', '--admin-socket', '/x/admin.sock'];

describe('cli', () => {
  test('a move runs, the summary goes to stdout, the progress to stderr, the key once and nowhere else', async () => {
    w = await makeWorld();
    const state = tmp();
    const c = capture();
    const seen: BuildInput[] = [];
    const code = await main(base, { env: { XDG_STATE_HOME: state }, io: c.io, build: worldBuild(w, seen), provisionScript: async () => '#!/bin/sh\n' });
    assert.equal(code, 0, c.err.join(''));
    assert.match(c.out.join(''), /ssh target:\s+admin@192\.0\.2\.1/);
    assert.match(c.out.join(''), /ed25519 SHA256:/);
    assert.ok(c.err.join('').includes('propose'));
    assert.match(seen[0]!.moveId, /^mv-[0-9a-f]{10}$/);
    assert.ok(fs.existsSync(path.join(state, 'coxia-provision', 'moves', seen[0]!.moveId, 'move.json')));
    assert.equal((c.out.join('') + c.err.join('')).includes(w.masterKey), false, 'the fake presenter keeps the key; the cli output does not carry it');
    fs.rmSync(state, { recursive: true });
  });

  test('a failure exits 1, says where, that the local instance is the owner, and how to resume', async () => {
    w = await makeWorld();
    w.failUpload(1);
    const state = tmp();
    const c = capture();
    const code = await main(base, { env: { XDG_STATE_HOME: state }, io: c.io, build: worldBuild(w), provisionScript: async () => '#!/bin/sh\n' });
    assert.equal(code, 1);
    const e = c.err.join('');
    assert.match(e, /failed at transfer/);
    assert.match(e, /owns the workspace again/);
    assert.match(e, /coxia-provision move --resume mv-[0-9a-f]{10}/);
    // and the resume goes through the same command
    const id = /--resume (mv-[0-9a-f]{10})/.exec(e)![1]!;
    const c2 = capture();
    w.deps.newId = undefined;
    const again = await main(['move', '--resume', id, '--admin-socket', '/x/admin.sock', '--recovery-copy-file', path.join(w.dir, 'nofile.key')], { env: { XDG_STATE_HOME: state }, io: c2.io, build: worldBuild(w), provisionScript: async () => '#!/bin/sh\n' });
    assert.equal(again, 1, 'the key was never written to a file, so the resume explains the loss');
    assert.match(c2.err.join(''), /handed over once/);
    fs.rmSync(state, { recursive: true });
  });

  test('usage errors exit 2 and touch nothing', async () => {
    const c = capture();
    const never = async (): Promise<Built> => assert.fail('must not build');
    assert.equal(await main(['move', '--plan', 'x'], { env: {}, io: c.io, build: never }), 2);
    assert.equal(await main(['move', '--admin-socket', '/s', '--plan', 'x', '--region', 'y', '--provider', 'fake'], { env: {}, io: c.io, build: never }), 2);
    assert.match(c.err.join(''), /--server-ref is required/);
    assert.equal(await main(['move', '--nope'], { env: {}, io: c.io, build: never }), 2);
    assert.equal(await main(['deploy'], { env: {}, io: c.io, build: never }), 2);
    assert.equal(await main(['move', '--resume', 'a', '--abort', 'b', '--admin-socket', '/s'], { env: {}, io: c.io, build: never }), 2);
  });
});

describe('token resolver', () => {
  test('reads a 0600 file, refuses a looser one, a link and a missing file; falls back to the environment', async () => {
    const dir = tmp();
    const token = `tok-cli-${randomBytes(6).toString('hex')}`;
    const f = path.join(dir, 't');
    fs.writeFileSync(f, `${token}\n`, { mode: 0o600 });
    assert.equal(await tokenResolver({ tokenFile: f, env: {} }).resolve('x'), token);
    fs.chmodSync(f, 0o644);
    await assert.rejects(tokenResolver({ tokenFile: f, env: {} }).resolve('x'), /readable by others/);
    fs.chmodSync(f, 0o600);
    fs.symlinkSync(f, path.join(dir, 'link'));
    await assert.rejects(tokenResolver({ tokenFile: path.join(dir, 'link'), env: {} }).resolve('x'), /regular file/);
    await assert.rejects(tokenResolver({ tokenFile: path.join(dir, 'none'), env: {} }).resolve('x'), /does not exist/);
    assert.equal(await tokenResolver({ tokenFile: undefined, env: { HOSTINGER_API_TOKEN: token } }).resolve('x'), token);
    await assert.rejects(tokenResolver({ tokenFile: undefined, env: {} }).resolve('x'), /no provider token/);
    fs.rmSync(dir, { recursive: true });
  });

  test('the state folder follows XDG_STATE_HOME, else ~/.local/state', () => {
    assert.equal(stateRoot({ XDG_STATE_HOME: '/s' }), '/s/coxia-provision/moves');
    assert.equal(stateRoot({}), path.join(os.homedir(), '.local', 'state', 'coxia-provision', 'moves'));
  });
});
