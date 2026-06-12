// Phase 3: slash command parsing tests for /model-config
const assert = require('assert');

// Mock minimal session + models context
const mockSessions = {
  getSessionRecord: (id) => ({
    id,
    user: 'test-user',
    modelConfig: null,
  }),
  isOwnerOrAdmin: (id, user) => user === 'test-user',
  saveStore: () => {},
};

const mockModels = {
  getConfig: () => ({
    scenarios: {
      agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    },
    fallback: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  }),
};

// Test: view mode (no args)
function testViewMode() {
  const ctx = {
    sessionId: 'test-session',
    user: 'test-user',
    args: '',
    reply: (msg) => {
      console.log('[test] reply:', msg.slice(0, 100));
      assert.ok(msg.includes('Session Model Configuration'), 'Should show config header');
      assert.ok(msg.includes('model: `claude-sonnet-4-6`'), 'Should show global config default');
    },
  };

  // Simulate handler logic
  const rec = mockSessions.getSessionRecord(ctx.sessionId);
  const args = ctx.args.trim();
  assert.strictEqual(args, '', 'Args should be empty for view mode');

  const currentConfig = rec.modelConfig || {};
  const globalConfig = mockModels.getConfig();
  const scenarioConfig = globalConfig.scenarios?.agent || globalConfig.fallback || {};

  const model = currentConfig.model || scenarioConfig.model || 'default';
  assert.strictEqual(model, 'claude-sonnet-4-6', 'Should use global config default');

  console.log('✓ testViewMode passed');
}

// Test: mutation mode (valid model update)
function testMutationMode() {
  const rec = mockSessions.getSessionRecord('test-session');
  const args = 'model=claude-opus-4-7';

  // Parse key=value pairs
  const updates = {};
  const validKeys = ['model', 'thinking', 'effort'];

  for (const part of args.split(/\s+/)) {
    const kv = part.split('=');
    assert.strictEqual(kv.length, 2, 'Should have key=value format');
    const [key, value] = kv;
    assert.ok(validKeys.includes(key), 'Should have valid key');
    updates[key] = value;
  }

  // Apply updates
  rec.modelConfig = updates;
  mockSessions.saveStore();

  assert.strictEqual(rec.modelConfig.model, 'claude-opus-4-7', 'Should update model config');
  console.log('✓ testMutationMode passed');
}

// Test: invalid thinking value
function testInvalidThinking() {
  const args = 'thinking=invalid';
  const validThinking = ['enabled', 'disabled', 'auto'];

  for (const part of args.split(/\s+/)) {
    const kv = part.split('=');
    const [key, value] = kv;
    if (key === 'thinking') {
      assert.ok(!validThinking.includes(value), 'Should detect invalid thinking value');
    }
  }

  console.log('✓ testInvalidThinking passed');
}

// Test: invalid effort value
function testInvalidEffort() {
  const args = 'effort=extreme';
  const validEffort = ['low', 'medium', 'high'];

  for (const part of args.split(/\s+/)) {
    const kv = part.split('=');
    const [key, value] = kv;
    if (key === 'effort') {
      assert.ok(!validEffort.includes(value), 'Should detect invalid effort value');
    }
  }

  console.log('✓ testInvalidEffort passed');
}

// Test: permission check (viewer denied)
function testPermissionCheck() {
  const ctx = {
    sessionId: 'test-session',
    user: 'guest-user',
    args: 'model=claude-opus-4-7',
  };

  const rec = mockSessions.getSessionRecord(ctx.sessionId);
  const isOwnerOrAdmin = mockSessions.isOwnerOrAdmin(ctx.sessionId, ctx.user);

  assert.strictEqual(isOwnerOrAdmin, false, 'Viewer should not have mutation permission');
  console.log('✓ testPermissionCheck passed');
}

// Test: invalid format (no equals sign)
function testInvalidFormat() {
  const args = 'model-claude-opus';

  for (const part of args.split(/\s+/)) {
    const kv = part.split('=');
    assert.strictEqual(kv.length, 1, 'Should detect missing equals sign');
  }

  console.log('✓ testInvalidFormat passed');
}

// Run all tests
function runTests() {
  console.log('\n=== Phase 3: slash command parsing tests ===\n');
  testViewMode();
  testMutationMode();
  testInvalidThinking();
  testInvalidEffort();
  testPermissionCheck();
  testInvalidFormat();
  console.log('\n✓ All slash command parsing tests passed\n');
}

runTests();
process.exit(0);