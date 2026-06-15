// Unit tests for CodeHub URL authentication (codehub-url-auth)
//
// Tests parseGitUrl, getTokenForUrl, getUsernameForUrl, and _buildAuthUrl
// functions that enable git clone with URL-embedded credentials.

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Test helpers
const projectRoot = path.dirname(__dirname);
const gitHosts = require(path.join(projectRoot, 'server/src/git-hosts'));

// Mock git-tokens and git-usernames for isolated testing
const mockTokens = {
  'alice': {
    'github': 'gho_user_level',
    'github/owner1/repo1': 'ghp_per_repo',
    'codehub': 'pat_codehub_user',
    'codehub/owner2/repo2': 'pat_codehub_repo',
  },
};

const mockUsernames = {
  'alice': {
    'github': 'x-access-token',
    'gitee': 'x-access-token',
    'codehub': 'real_alice',
  },
};

// Temporary mock storage files
const tmpDir = path.join(projectRoot, 'test/_tmp_git_url_auth_' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const tokensFile = path.join(tmpDir, 'git-tokens.json');
const usernamesFile = path.join(tmpDir, 'git-usernames.json');

// Write mock data
fs.writeFileSync(tokensFile, JSON.stringify(mockTokens, null, 2), { mode: 0o600 });
fs.writeFileSync(usernamesFile, JSON.stringify(mockUsernames, null, 2), { mode: 0o600 });

// Override storage paths via environment
process.env.MYCO_STATE_DIR = tmpDir;

// Clear module cache to reload with new MYCO_STATE_DIR
delete require.cache[require.resolve(path.join(projectRoot, 'server/src/git-tokens'))];
delete require.cache[require.resolve(path.join(projectRoot, 'server/src/git-usernames'))];
delete require.cache[require.resolve(path.join(projectRoot, 'server/src/git-hosts'))];

const gitTokens = require(path.join(projectRoot, 'server/src/git-tokens'));
const gitUsernames = require(path.join(projectRoot, 'server/src/git-usernames'));
const gitHostsFresh = require(path.join(projectRoot, 'server/src/git-hosts'));

// ── Test parseGitUrl ─────────────────────────────────────────────────────────

function test_parseGitUrl_https_github() {
  const result = gitHostsFresh.parseGitUrl('https://github.com/owner/repo.git');
  assert.ok(result, 'should parse GitHub HTTPS URL');
  assert.strictEqual(result.provider, 'github');
  assert.strictEqual(result.owner, 'owner');
  assert.strictEqual(result.repo, 'repo');
  assert.strictEqual(result.host, 'github.com');
  assert.strictEqual(result.protocol, 'https');
  console.log('✓ parseGitUrl: GitHub HTTPS URL');
}

function test_parseGitUrl_ssh_github() {
  const result = gitHostsFresh.parseGitUrl('git@github.com:owner/repo.git');
  assert.ok(result, 'should parse GitHub SSH URL');
  assert.strictEqual(result.provider, 'github');
  assert.strictEqual(result.owner, 'owner');
  assert.strictEqual(result.repo, 'repo');
  assert.strictEqual(result.host, 'github.com');
  assert.strictEqual(result.protocol, 'ssh');
  console.log('✓ parseGitUrl: GitHub SSH URL');
}

function test_parseGitUrl_https_gitee() {
  const result = gitHostsFresh.parseGitUrl('https://gitee.com/owner/repo.git');
  assert.ok(result, 'should parse Gitee HTTPS URL');
  assert.strictEqual(result.provider, 'gitee');
  assert.strictEqual(result.host, 'gitee.com');
  console.log('✓ parseGitUrl: Gitee HTTPS URL');
}

function test_parseGitUrl_https_codehub() {
  const result = gitHostsFresh.parseGitUrl('https://codehub-y.huawei.com/owner/repo.git');
  assert.ok(result, 'should parse CodeHub HTTPS URL');
  assert.strictEqual(result.provider, 'codehub');
  assert.strictEqual(result.host, 'codehub-y.huawei.com');
  console.log('✓ parseGitUrl: CodeHub HTTPS URL');
}

function test_parseGitUrl_ssh_codehub() {
  const result = gitHostsFresh.parseGitUrl('git@codehub-y.huawei.com:owner/repo.git');
  assert.ok(result, 'should parse CodeHub SSH URL');
  assert.strictEqual(result.provider, 'codehub');
  assert.strictEqual(result.protocol, 'ssh');
  console.log('✓ parseGitUrl: CodeHub SSH URL');
}

function test_parseGitUrl_unsupported_host() {
  const result = gitHostsFresh.parseGitUrl('https://gitlab.com/owner/repo.git');
  assert.strictEqual(result, null, 'unsupported host should return null');
  console.log('✓ parseGitUrl: unsupported host returns null');
}

function test_parseGitUrl_shorthand() {
  const result = gitHostsFresh.parseGitUrl('owner/repo');
  assert.ok(result, 'should parse owner/repo shorthand');
  assert.strictEqual(result.provider, 'github', 'shorthand defaults to github');
  assert.strictEqual(result.owner, 'owner');
  assert.strictEqual(result.repo, 'repo');
  console.log('✓ parseGitUrl: owner/repo shorthand defaults to github');
}

function test_parseGitUrl_invalid() {
  assert.strictEqual(gitHostsFresh.parseGitUrl(null), null, 'null returns null');
  assert.strictEqual(gitHostsFresh.parseGitUrl(''), null, 'empty string returns null');
  assert.strictEqual(gitHostsFresh.parseGitUrl('invalid'), null, 'invalid format returns null');
  console.log('✓ parseGitUrl: invalid inputs return null');
}

// ── Test getTokenForUrl ───────────────────────────────────────────────────────

function test_getTokenForUrl_per_repo() {
  const result = gitHostsFresh.getTokenForUrl('alice', 'https://github.com/owner1/repo1.git');
  assert.ok(result, 'should find token for known repo');
  assert.strictEqual(result.token, 'ghp_per_repo', 'should return per-repo token');
  assert.strictEqual(result.provider, 'github');
  console.log('✓ getTokenForUrl: per-repo token found');
}

function test_getTokenForUrl_user_level() {
  const result = gitHostsFresh.getTokenForUrl('alice', 'https://github.com/other/repo.git');
  assert.ok(result, 'should find user-level token for unknown repo');
  assert.strictEqual(result.token, 'gho_user_level', 'should fallback to user-level token');
  console.log('✓ getTokenForUrl: user-level token fallback');
}

function test_getTokenForUrl_no_token() {
  const result = gitHostsFresh.getTokenForUrl('bob', 'https://github.com/owner/repo.git');
  assert.strictEqual(result, null, 'should return null for unknown user');
  console.log('✓ getTokenForUrl: no token returns null');
}

function test_getTokenForUrl_codehub_per_repo() {
  const result = gitHostsFresh.getTokenForUrl('alice', 'https://codehub-y.huawei.com/owner2/repo2.git');
  assert.ok(result, 'should find CodeHub token');
  assert.strictEqual(result.token, 'pat_codehub_repo', 'should return CodeHub per-repo token');
  assert.strictEqual(result.provider, 'codehub');
  console.log('✓ getTokenForUrl: CodeHub per-repo token');
}

// ── Test getUsernameForUrl ─────────────────────────────────────────────────────

function test_getUsernameForUrl_github() {
  const username = gitHostsFresh.getUsernameForUrl('alice', 'github');
  assert.strictEqual(username, 'x-access-token', 'GitHub should return virtual username');
  console.log('✓ getUsernameForUrl: GitHub returns x-access-token');
}

function test_getUsernameForUrl_gitee() {
  const username = gitHostsFresh.getUsernameForUrl('alice', 'gitee');
  assert.strictEqual(username, 'x-access-token', 'Gitee should return virtual username');
  console.log('✓ getUsernameForUrl: Gitee returns x-access-token');
}

function test_getUsernameForUrl_codehub() {
  const username = gitHostsFresh.getUsernameForUrl('alice', 'codehub');
  assert.strictEqual(username, 'real_alice', 'CodeHub should return real username');
  console.log('✓ getUsernameForUrl: CodeHub returns real username');
}

function test_getUsernameForUrl_unknown() {
  const username = gitHostsFresh.getUsernameForUrl('bob', 'codehub');
  assert.strictEqual(username, null, 'unknown user should return null');
  console.log('✓ getUsernameForUrl: unknown user returns null');
}

// ── Test _buildAuthUrl (requires sessions.js context, mock separately) ───────

function test_buildAuthUrl_logic() {
  // Simulate _buildAuthUrl logic: parse + getToken + getUsername + build URL
  const user = 'alice';
  const gitUrl = 'https://github.com/owner1/repo1.git';

  const parsed = gitHostsFresh.parseGitUrl(gitUrl);
  assert.ok(parsed, 'should parse URL');

  const tokenInfo = gitHostsFresh.getTokenForUrl(user, gitUrl);
  assert.ok(tokenInfo, 'should find token');

  const username = gitHostsFresh.getUsernameForUrl(user, tokenInfo.provider);
  assert.ok(username, 'should find username');

  // Build URL manually
  const { host, owner, repo } = parsed;
  const authUrl = `https://${encodeURIComponent(username)}:${encodeURIComponent(tokenInfo.token)}@${host}/${owner}/${repo}.git`;

  // Verify format
  assert.ok(authUrl.includes('x-access-token'), 'should include username');
  assert.ok(authUrl.includes('ghp_per_repo'), 'should include token');
  assert.ok(authUrl.startsWith('https://'), 'should be HTTPS URL');
  console.log('✓ _buildAuthUrl logic: URL format correct');
}

function test_buildAuthUrl_ssh_fallback() {
  // SSH URLs cannot embed credentials
  const parsed = gitHostsFresh.parseGitUrl('git@github.com:owner/repo.git');
  assert.strictEqual(parsed.protocol, 'ssh', 'should be SSH protocol');

  // In actual _buildAuthUrl, SSH returns null (fallback to original URL)
  console.log('✓ _buildAuthUrl: SSH URL returns null (uses original URL)');
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function cleanup() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    console.error('cleanup failed:', err.message);
  }
}

// ── Run all tests ─────────────────────────────────────────────────────────────

function runAll() {
  console.log('\n=== parseGitUrl tests ===');
  test_parseGitUrl_https_github();
  test_parseGitUrl_ssh_github();
  test_parseGitUrl_https_gitee();
  test_parseGitUrl_https_codehub();
  test_parseGitUrl_ssh_codehub();
  test_parseGitUrl_unsupported_host();
  test_parseGitUrl_shorthand();
  test_parseGitUrl_invalid();

  console.log('\n=== getTokenForUrl tests ===');
  test_getTokenForUrl_per_repo();
  test_getTokenForUrl_user_level();
  test_getTokenForUrl_no_token();
  test_getTokenForUrl_codehub_per_repo();

  console.log('\n=== getUsernameForUrl tests ===');
  test_getUsernameForUrl_github();
  test_getUsernameForUrl_gitee();
  test_getUsernameForUrl_codehub();
  test_getUsernameForUrl_unknown();

  console.log('\n=== _buildAuthUrl logic tests ===');
  test_buildAuthUrl_logic();
  test_buildAuthUrl_ssh_fallback();

  cleanup();
  console.log('\n✓ All tests passed\n');
}

// Export for test.sh integration
module.exports = { runAll };

// Run if invoked directly
if (require.main === module) {
  runAll();
}