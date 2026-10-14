import { randomBytes } from 'node:crypto';
import { after } from 'node:test';
import { runProviderContract } from './contract.ts';
import { startFakeHostinger } from './hostinger-server.ts';
import { createHostingerProvider } from '../src/hostinger/provider.ts';
import type { ProviderErrorCode } from '../src/provider.ts';
import { memorySecrets } from './helpers.ts';

// Made at run time: a literal token, even a fake one, trips secret scanners.
const TOKEN = `tok-hostinger-${randomBytes(8).toString('hex')}`;
const WRONG = `tok-wrong-${randomBytes(8).toString('hex')}`;
const server = await startFakeHostinger(TOKEN);
after(() => server.close());

// Only the statuses the OpenAPI document names for these calls. A 429 is retried 3 times and a 5xx once, so the fake fails the call that many times plus one.
const FAILURES: Partial<Record<ProviderErrorCode, [status: number, times: number, headers: Record<string, string>]>> = {
  'not-found': [404, 1, {}],
  'invalid-input': [422, 1, {}],
  'rate-limited': [429, 4, { 'retry-after': '0' }],
  'provider-unavailable': [500, 2, {}],
};

runProviderContract('hostinger', () => {
  server.vms.length = 0;
  server.subs.length = 0;
  server.scripts = [];
  server.mode = 'ok';
  const secrets = memorySecrets({ good: TOKEN, bad: WRONG });
  const build = (tokenRef: string) => createHostingerProvider({ secrets, tokenRef, baseUrl: server.url, sleep: async () => undefined });
  return {
    provider: build('good'),
    token: TOKEN,
    rejected: { provider: build('bad'), token: WRONG },
    image: 'Ubuntu 24.04 LTS',
    sshKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests test@example.com',
    period: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.000Z' },
    failCodes: Object.keys(FAILURES) as ProviderErrorCode[],
    failNext: (code, leak) => {
      const [status, times, headers] = FAILURES[code]!;
      server.failNext(status, times, { message: `forced ${leak}`, correlation_id: 'c-forced' }, headers);
    },
  };
});
