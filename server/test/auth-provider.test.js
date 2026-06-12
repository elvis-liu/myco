// Unit tests for auth.js provider-prefix allowlist support.
// Tests parseAllowlistEntry, KNOWN_PROVIDERS, and getAllAllowedLogins.

const { test, describe } = require('node:test');
const assert = require('assert');
const auth = require('../src/auth');

describe('parseAllowlistEntry', () => {
  test('parses github:alice', () => {
    const result = auth.parseAllowlistEntry('github:alice');
    assert.deepStrictEqual(result, { provider: 'github', login: 'alice' });
  });

  test('parses gitee:bob', () => {
    const result = auth.parseAllowlistEntry('gitee:bob');
    assert.deepStrictEqual(result, { provider: 'gitee', login: 'bob' });
  });

  test('defaults bare username to github', () => {
    const result = auth.parseAllowlistEntry('charlie');
    assert.deepStrictEqual(result, { provider: 'github', login: 'charlie' });
  });

  test('sanitizes special chars in username', () => {
    const result = auth.parseAllowlistEntry('github:alice@test');
    assert.deepStrictEqual(result, { provider: 'github', login: 'alicetest' });
  });

  test('rejects unknown provider', () => {
    const result = auth.parseAllowlistEntry('gitlab:alice');
    assert.strictEqual(result, null);
  });

  test('returns null for empty entry', () => {
    assert.strictEqual(auth.parseAllowlistEntry(''), null);
    assert.strictEqual(auth.parseAllowlistEntry(null), null);
    assert.strictEqual(auth.parseAllowlistEntry(undefined), null);
  });

  test('handles whitespace', () => {
    const result = auth.parseAllowlistEntry('  github:dave  ');
    assert.deepStrictEqual(result, { provider: 'github', login: 'dave' });
  });

  test('handles provider case-insensitively', () => {
    const result = auth.parseAllowlistEntry('GITHUB:eve');
    assert.deepStrictEqual(result, { provider: 'github', login: 'eve' });
  });

  test('rejects colon at start (no provider)', () => {
    const result = auth.parseAllowlistEntry(':alice');
    assert.strictEqual(result, null);
  });
});

describe('KNOWN_PROVIDERS', () => {
  test('contains github and gitee', () => {
    assert.ok(auth.KNOWN_PROVIDERS.has('github'));
    assert.ok(auth.KNOWN_PROVIDERS.has('gitee'));
  });

  test('does not contain unknown providers', () => {
    assert.ok(!auth.KNOWN_PROVIDERS.has('gitlab'));
    assert.ok(!auth.KNOWN_PROVIDERS.has('bitbucket'));
  });
});

describe('getAllAllowedLogins', () => {
  test('returns Set of bare usernames', () => {
    const logins = auth.getAllAllowedLogins();
    assert.ok(logins instanceof Set);
    for (const login of logins) {
      assert.ok(typeof login === 'string');
      assert.ok(!login.includes(':')); // No provider prefix
    }
  });
});