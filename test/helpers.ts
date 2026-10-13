import type { SecretResolver } from '../src/ports.ts';

export const memorySecrets = (values: Record<string, string>): SecretResolver => ({
  resolve: async (ref) => {
    const v = values[ref];
    if (v === undefined) throw new Error(`no secret ${ref}`);
    return v;
  },
});
