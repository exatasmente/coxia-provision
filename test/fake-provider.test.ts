import { randomBytes } from 'node:crypto';
import { runProviderContract } from './contract.ts';
import { createFakeProvider } from '../src/fakeProvider.ts';
import { memorySecrets } from './helpers.ts';

// Made at run time: a literal token, even a fake one, trips secret scanners.
const TOKEN = `tok-fake-${randomBytes(6).toString('hex')}`;
const WRONG = `tok-wrong-${randomBytes(6).toString('hex')}`;

runProviderContract('fake', () => {
  const secrets = memorySecrets({ 'fake-token': TOKEN, 'fake-wrong': WRONG });
  const provider = createFakeProvider({ secrets, tokenRef: 'fake-token', token: TOKEN });
  const rejected = createFakeProvider({ secrets, tokenRef: 'fake-wrong', token: TOKEN });
  return {
    provider,
    token: TOKEN,
    rejected: { provider: rejected, token: WRONG },
    image: 'ubuntu-24.04',
    sshKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests test@example.com',
    period: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.000Z' },
    failNext: (code, leak) => provider.failNext(code, leak),
  };
});
