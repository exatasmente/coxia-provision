import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Keeps the test runner and the typecheck wired before the first module lands.
test('the package is an ES module', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { type?: string };
  assert.equal(pkg.type, 'module');
});
