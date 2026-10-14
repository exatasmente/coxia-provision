import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { connectAdminDoor } from '../src/adminDoor.ts';
import type { CoreClient } from '../src/adminDoor.ts';
import { coreAccountCheck, coreDestroyGuard, coreSpendGate, fileAuditSink } from '../src/corePorts.ts';
import { GuardError } from '../src/ports.ts';
import { FakeWireError, startFakeDoor } from './admin-door-server.ts';
import type { FakeDoor } from './admin-door-server.ts';

let door: FakeDoor | undefined;
let core: CoreClient | undefined;
afterEach(async () => {
  core?.close();
  await door?.close();
  door = core = undefined;
});

async function up(): Promise<{ door: FakeDoor; core: CoreClient }> {
  door = await startFakeDoor();
  core = await connectAdminDoor(door.socketPath);
  return { door, core };
}

const spendReq = { kind: 'spend', category: 'infrastructure', accountId: 'acct-1', amount: 12, currency: 'USD', recurrence: 'once', summary: 'create server x' } as const;

describe('core-backed ports', () => {
  test('accounts:assert returns the account; forbidden stays a guard error', async () => {
    const { door, core } = await up();
    door.handle('accounts:assert', ([a]) => {
      if ((a as { provider: string }).provider !== 'hostinger') throw new FakeWireError('forbidden', 'no account');
      return { id: 'acct-1', provider: 'hostinger', secretRefs: ['hostinger.token'] };
    });
    const check = coreAccountCheck(core);
    assert.deepEqual(await check.assert('hostinger'), { id: 'acct-1', provider: 'hostinger', secretRefs: ['hostinger.token'] });
    await assert.rejects(check.assert('other'), (e: unknown) => e instanceof GuardError && e.code === 'forbidden');
  });

  test('a spend is requested, polled while pending, then allowed; the same key is reused', async () => {
    const { door, core } = await up();
    let n = 0;
    door.handle('effects:request', () => (++n < 3 ? { state: 'pending', proposalId: 'p1' } : { state: 'allowed', allowedBy: 'person', ticket: 'tk1', expiresAt: 'x' }));
    const sleeps: number[] = [];
    const gate = coreSpendGate({ core, requestId: () => 'move-abc12345-spend', sleep: async (ms) => void sleeps.push(ms), pollMs: 7 });
    assert.deepEqual(await gate.authorize(spendReq), { ok: true, allowedBy: 'person', ticket: 'tk1' });
    assert.deepEqual(sleeps, [7, 7]);
    const sent = door.calls.filter((c) => c.channel === 'effects:request').map((c) => c.args[0] as Record<string, unknown>);
    assert.equal(sent.length, 3);
    assert.ok(sent.every((s) => s.requestId === 'move-abc12345-spend' && s.kind === 'spend' && s.amount === 12 && s.currency === 'USD' && s.recurrence === 'once'));
  });

  test('the budget, a refusal and a timeout are refusals; a conflict makes the port unable to decide', async () => {
    const { door, core } = await up();
    door.handle('effects:request', () => {
      throw new FakeWireError('budget-exceeded', 'over the limit');
    });
    assert.deepEqual(await coreSpendGate({ core }).authorize(spendReq), { ok: false, code: 'budget-exceeded', reason: 'over the limit' });

    door.handle('effects:request', () => ({ state: 'pending', proposalId: 'p' }));
    let t = 0;
    const waited = await coreSpendGate({ core, waitMs: 100, now: () => (t += 60), sleep: async () => undefined }).authorize(spendReq);
    assert.equal(waited.ok, false);
    assert.equal(!waited.ok && waited.code, 'forbidden');

    door.handle('effects:request', () => {
      throw new FakeWireError('conflict', 'other args');
    });
    await assert.rejects(coreSpendGate({ core }).authorize(spendReq), (e: unknown) => (e as { code?: string }).code === 'conflict');
  });

  test('settle records the actual cost; a destroy asks kind destroy and closes with amount 0', async () => {
    const { door, core } = await up();
    door.handle('effects:settle', () => ({ entryId: null, overrun: false }));
    door.handle('effects:request', () => ({ state: 'allowed', allowedBy: 'grant:g', ticket: 'td', expiresAt: 'x' }));
    await coreSpendGate({ core }).settle('tk1', { amount: 11.5, currency: 'USD' });
    const guard = coreDestroyGuard({ core, requestId: () => 'move-abc12345-destroy', currency: () => 'EUR' });
    assert.deepEqual(await guard.confirm({ accountId: 'acct-1', serverId: 'srv-1', summary: 'destroy server srv-1' }), { ok: true, allowedBy: 'grant:g', ticket: 'td' });
    await guard.close('td', 'done');
    assert.deepEqual(door.calls.find((c) => c.channel === 'effects:settle')?.args, [{ ticket: 'tk1', actual: { amount: 11.5, currency: 'USD' } }]);
    assert.deepEqual(door.calls.find((c) => c.channel === 'effects:request')?.args, [{ requestId: 'move-abc12345-destroy', kind: 'destroy', accountId: 'acct-1', summary: 'destroy server srv-1', target: 'srv-1' }]);
    assert.deepEqual(door.calls.filter((c) => c.channel === 'effects:settle')[1]?.args, [{ ticket: 'td', actual: { amount: 0, currency: 'EUR' } }]);
  });

  test('the audit sink appends json lines in a 0600 file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxp-audit-'));
    const file = path.join(dir, 'audit.log');
    const sink = fileAuditSink(file);
    await sink({ at: 't', op: 'create-server', provider: 'p', accountId: 'a', target: 'x', result: 'done', summary: 's' });
    await sink({ at: 't2', op: 'destroy-server', provider: 'p', accountId: 'a', target: 'x', result: 'refused', summary: 's' });
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.rmSync(dir, { recursive: true });
  });
});
