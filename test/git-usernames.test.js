// Test git-usernames.js storage module.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Set env BEFORE requiring the module so STATE_DIR is picked up.
const TMP_DIR = path.join(os.tmpdir(), 'git-usernames-test-' + Date.now());
process.env.MYCO_STATE_DIR = TMP_DIR;
const gitUsernames = require('../server/src/git-usernames');
const FILE = gitUsernames._file();

function setup() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  process.env.MYCO_STATE_DIR = TMP_DIR;
  gitUsernames._resetCacheForTest();
}

function teardown() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  delete process.env.MYCO_STATE_DIR;
  gitUsernames._resetCacheForTest();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

function test_setAndGet() {
  setup();
  gitUsernames.setUsername('alice', 'codehub', 'realuser');
  assert.strictEqual(gitUsernames.getUsername('alice', 'codehub'), 'realuser', 'must store codehub username');

  gitUsernames.setUsername('alice', 'github', 'x-access-token');
  assert.strictEqual(gitUsernames.getUsername('alice', 'github'), 'x-access-token', 'must store github virtual username');

  // Persist to disk
  const raw = fs.readFileSync(FILE, 'utf8');
  const data = JSON.parse(raw);
  assert.strictEqual(data.alice.codehub, 'realuser', 'persisted codehub username');
  assert.strictEqual(data.alice.github, 'x-access-token', 'persisted github virtual username');

  teardown();
  console.log('✓ test_setAndGet passed');
}

function test_getMissing() {
  setup();
  assert.strictEqual(gitUsernames.getUsername('bob', 'codehub'), null, 'missing user returns null');
  assert.strictEqual(gitUsernames.getUsername('alice', 'gitee'), null, 'missing provider slot returns null');
  teardown();
  console.log('✓ test_getMissing passed');
}

function test_remove() {
  setup();
  gitUsernames.setUsername('alice', 'codehub', 'realuser');
  assert.strictEqual(gitUsernames.removeUsername('alice', 'codehub'), true, 'remove returns true when found');

  assert.strictEqual(gitUsernames.getUsername('alice', 'codehub'), null, 'removed username is null');
  assert.strictEqual(gitUsernames.removeUsername('alice', 'codehub'), false, 'remove returns false when not found');

  teardown();
  console.log('✓ test_remove passed');
}

function test_invalidProvider() {
  setup();
  try {
    gitUsernames.setUsername('alice', 'unknown', 'foo');
    assert.fail('must throw for unknown provider');
  } catch (e) {
    assert.ok(e.message.includes('unknown provider'), 'error mentions unknown provider');
  }
  assert.strictEqual(gitUsernames.getUsername('alice', 'unknown'), null, 'unknown provider returns null');
  teardown();
  console.log('✓ test_invalidProvider passed');
}

function test_listAll() {
  setup();
  gitUsernames.setUsername('alice', 'github', 'x-access-token');
  gitUsernames.setUsername('alice', 'codehub', 'realuser');

  const all = gitUsernames.listAll('alice');
  assert.strictEqual(all.github, 'x-access-token', 'listAll has github');
  assert.strictEqual(all.gitee, null, 'listAll gitee is null');
  assert.strictEqual(all.codehub, 'realuser', 'listAll has codehub');

  teardown();
  console.log('✓ test_listAll passed');
}

function test_concurrentWrites() {
  setup();
  gitUsernames.setUsername('alice', 'github', 'x-access-token');
  gitUsernames.setUsername('alice', 'codehub', 'realuser');

  // Simulate concurrent write: both should persist
  gitUsernames.setUsername('bob', 'codehub', 'bobuser');
  gitUsernames._resetCacheForTest(); // force reload from disk
  assert.strictEqual(gitUsernames.getUsername('alice', 'github'), 'x-access-token', 'alice github still present');
  assert.strictEqual(gitUsernames.getUsername('alice', 'codehub'), 'realuser', 'alice codehub still present');
  assert.strictEqual(gitUsernames.getUsername('bob', 'codehub'), 'bobuser', 'bob codehub present');

  teardown();
  console.log('✓ test_concurrentWrites passed');
}

function test_filePermissions() {
  setup();
  gitUsernames.setUsername('alice', 'codehub', 'realuser');

  const stats = fs.statSync(FILE);
  const mode = stats.mode & 0o777;
  assert.strictEqual(mode, 0o600, 'file mode must be 0600');

  teardown();
  console.log('✓ test_filePermissions passed');
}

// ── Run ───────────────────────────────────────────────────────────────────────

test_setAndGet();
test_getMissing();
test_remove();
test_invalidProvider();
test_listAll();
test_concurrentWrites();
test_filePermissions();

console.log('\nAll git-usernames tests passed.\n');