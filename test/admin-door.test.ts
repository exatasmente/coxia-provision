import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { AdminDoorError, connectAdminDoor } from '../src/adminDoor.ts';
import { FakeWireError, startFakeDoor } from './admin-door-server.ts';
import type { FakeDoor } from './admin-door-server.ts';

let door: FakeDoor | undefined;
afterEach(async () => {
  await door?.close();
  door = undefined;
});

describe('admin door client', () => {
  test('says hello, reads the workspace, calls a channel and ignores events', async () => {
    door = await startFakeDoor({ workspace: 'principal' });
    door.handle('ownership:status', () => ({ role: 'owner' }));
    const c = await connectAdminDoor(door.socketPath);
    assert.equal(c.workspace, 'principal');
    assert.deepEqual(await c.call('ownership:status', []), { role: 'owner' });
    assert.deepEqual(door.calls, [{ channel: 'ownership:status', args: [] }]);
    c.close();
  });

  test('an error answer carries the core code and says it was answered', async () => {
    door = await startFakeDoor();
    door.handle('ownership:move-out', () => {
      throw new FakeWireError('not-owner', 'not the owner');
    });
    const c = await connectAdminDoor(door.socketPath);
    const e = await c.call('ownership:move-out', [{ to: 'x' }]).then(() => assert.fail('should throw'), (x: unknown) => x);
    assert.ok(e instanceof AdminDoorError);
    assert.equal(e.code, 'not-owner');
    assert.equal(e.answered, true);
    c.close();
  });

  test('a contract mismatch is refused at the hello', async () => {
    door = await startFakeDoor({ version: 2 });
    await assert.rejects(connectAdminDoor(door.socketPath), (e: unknown) => e instanceof AdminDoorError && e.code === 'contract-mismatch');
  });

  test('a dropped connection is not an answer', async () => {
    door = await startFakeDoor();
    door.dropOn('x:y');
    const c = await connectAdminDoor(door.socketPath);
    const e = await c.call('x:y').then(() => assert.fail('should throw'), (x: unknown) => x);
    assert.ok(e instanceof AdminDoorError);
    assert.equal(e.answered, false);
    assert.equal(e.code, 'closed');
  });

  test('a call that is not answered in time times out, and several calls may be in flight', async () => {
    door = await startFakeDoor();
    door.handle('slow', () => new Promise(() => undefined));
    door.handle('fast', () => 1);
    const c = await connectAdminDoor(door.socketPath);
    const slow = c.call('slow', [], { timeoutMs: 50 });
    assert.equal(await c.call('fast'), 1);
    await assert.rejects(slow, (e: unknown) => e instanceof AdminDoorError && e.code === 'timeout' && !e.answered);
    c.close();
  });

  test('no socket is a closed error', async () => {
    await assert.rejects(connectAdminDoor('/nonexistent/admin.sock'), (e: unknown) => e instanceof AdminDoorError && e.answered === false);
  });
});
