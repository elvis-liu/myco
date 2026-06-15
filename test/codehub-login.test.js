// Test CodeHub login integration: username stored in git-usernames.json.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Set env BEFORE requiring modules.
const TMP_DIR = path.join(os.tmpdir(), 'codehub-login-test-' + Date.now());
process.env.MYCO_STATE_DIR = TMP_DIR;
process.env.MYCO_PORT = '0'; // let server pick random port

const gitUsernames = require('../server/src/git-usernames');
const gitTokens = require('../server/src/git-tokens');

function setup() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  // Write empty allowed-users file
  fs.writeFileSync(path.join(TMP_DIR, 'allowed-codehub-users.txt'), 'testuser\n', { mode: 0o600 });
  gitUsernames._resetCacheForTest();
  gitTokens._resetCacheForTest();
}

function teardown() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  delete process.env.MYCO_STATE_DIR;
  delete process.env.MYCO_PORT;
  gitUsernames._resetCacheForTest();
  gitTokens._resetCacheForTest();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

function test_codehubLoginStoresUsername() {
  setup();

  // Simulate what /auth/login does after successful CodeHub PAT login
  const login = 'testuser';
  const provider = 'codehub';
  const pat = 'test-pat-token';
  const user = { login: 'realCodeHubUser' };

  gitTokens.setUserToken(login, provider, pat);
  const gitUsername = provider === 'codehub' ? user.login : 'x-access-token';
  gitUsernames.setUsername(login, provider, gitUsername);

  // Verify token stored
  assert.strictEqual(gitTokens.getToken(login, provider), pat, 'PAT stored');

  // Verify username stored correctly
  assert.strictEqual(gitUsernames.getUsername(login, provider), 'realCodeHubUser', 'CodeHub real username stored');

  // Verify persisted to disk
  const usernamesFile = gitUsernames._file();
  const raw = fs.readFileSync(usernamesFile, 'utf8');
  const data = JSON.parse(raw);
  assert.strictEqual(data.testuser.codehub, 'realCodeHubUser', 'persisted to git-usernames.json');

  teardown();
  console.log('✓ test_codehubLoginStoresUsername passed');
}

function test_githubLoginStoresVirtualUsername() {
  setup();

  // Simulate GitHub OAuth login (uses virtual username)
  const login = 'ghuser';
  const provider = 'github';
  const pat = 'gh-oauth-token';

  gitTokens.setUserToken(login, provider, pat);
  const gitUsername = provider === 'codehub' ? 'realuser' : 'x-access-token';
  gitUsernames.setUsername(login, provider, gitUsername);

  // Verify virtual username stored
  assert.strictEqual(gitUsernames.getUsername(login, provider), 'x-access-token', 'GitHub virtual username stored');

  teardown();
  console.log('✓ test_githubLoginStoresVirtualUsername passed');
}

function test_giteeLoginStoresVirtualUsername() {
  setup();

  const login = 'giteeuser';
  const provider = 'gitee';
  const pat = 'gitee-pat-token';

  gitTokens.setUserToken(login, provider, pat);
  const gitUsername = provider === 'codehub' ? 'realuser' : 'x-access-token';
  gitUsernames.setUsername(login, provider, gitUsername);

  assert.strictEqual(gitUsernames.getUsername(login, provider), 'x-access-token', 'Gitee virtual username stored');

  teardown();
  console.log('✓ test_giteeLoginStoresVirtualUsername passed');
}

// ── Run ───────────────────────────────────────────────────────────────────────

test_codehubLoginStoresUsername();
test_githubLoginStoresVirtualUsername();
test_giteeLoginStoresVirtualUsername();

console.log('\nAll codehub-login tests passed.\n');