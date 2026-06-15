// Test git-credential-myco.sh CodeHub support via node inline script.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const TMP_DIR = path.join(os.tmpdir(), 'git-credential-test-' + Date.now());
const TOKENS_FILE = path.join(TMP_DIR, 'git-tokens.json');
const USERNAMES_FILE = path.join(TMP_DIR, 'git-usernames.json');
const CWD_DIR = path.join(TMP_DIR, 'wks', 'testuser', 'session-abc');

// Extract the node inline script from git-credential-myco.sh
function extractNodeScript() {
  const shPath = path.join(__dirname, '../scripts/git-credential-myco.sh');
  const sh = fs.readFileSync(shPath, 'utf8');
  // Find node -e '...' block
  const match = sh.match(/node -e '\n([\s\S]*?)'\s*2>\/dev\/null/);
  if (!match) throw new Error('Could not extract node script');
  return match[1];
}

// Run the node script with mocked env + stdin
function runCredentialHelper(stdin, mycoCwd) {
  const stdinTmp = path.join(TMP_DIR, 'stdin-' + Date.now());
  fs.writeFileSync(stdinTmp, stdin);
  const nodeScript = extractNodeScript();
  const env = {
    MYCO_TOKENS_FILE: TOKENS_FILE,
    MYCO_USERNAMES_FILE: USERNAMES_FILE,
    MYCO_CWD: mycoCwd || CWD_DIR,
    MYCO_STDIN_PATH: stdinTmp,
  };
  try {
    const out = execSync(`node -e '${nodeScript.replace(/'/g, "'\"'\"'")}'`, {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 5000,
    });
    return out;
  } catch (e) {
    return e.stdout || '';
  }
}

function setup() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(CWD_DIR, { recursive: true });
}

function teardown() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
}

// ── Tests ─────────────────────────────────────────────────────────────────────

function test_codehubHostMapping() {
  setup();

  // Store token + username
  const tokens = { testuser: { codehub: 'test-pat-token' } };
  const usernames = { testuser: { codehub: 'realCodeHubUser' } };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens), { mode: 0o600 });
  fs.writeFileSync(USERNAMES_FILE, JSON.stringify(usernames), { mode: 0o600 });

  const stdin = 'protocol=https\nhost=codehub-y.huawei.com\npath=owner/repo.git\n\n';
  const out = runCredentialHelper(stdin);

  assert.ok(out.includes('username=realCodeHubUser'), 'must output real CodeHub username');
  assert.ok(out.includes('password=test-pat-token'), 'must output PAT');

  teardown();
  console.log('✓ test_codehubHostMapping passed');
}

function test_codehubMissingUsername() {
  setup();

  // Store token but no username
  const tokens = { testuser: { codehub: 'test-pat-token' } };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens), { mode: 0o600 });
  // No usernames file

  const stdin = 'protocol=https\nhost=codehub-y.huawei.com\npath=owner/repo.git\n\n';
  const out = runCredentialHelper(stdin);

  assert.strictEqual(out.trim(), '', 'must emit nothing when username missing');

  teardown();
  console.log('✓ test_codehubMissingUsername passed');
}

function test_githubStillUsesVirtualUsername() {
  setup();

  const tokens = { testuser: { github: 'gh-token' } };
  const usernames = { testuser: { github: 'x-access-token' } };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens), { mode: 0o600 });
  fs.writeFileSync(USERNAMES_FILE, JSON.stringify(usernames), { mode: 0o600 });

  const stdin = 'protocol=https\nhost=github.com\npath=owner/repo.git\n\n';
  const out = runCredentialHelper(stdin);

  assert.ok(out.includes('username=x-access-token'), 'GitHub must use virtual username');
  assert.ok(out.includes('password=gh-token'), 'must output GitHub token');

  teardown();
  console.log('✓ test_githubStillUsesVirtualUsername passed');
}

function test_giteeStillUsesVirtualUsername() {
  setup();

  const tokens = { testuser: { gitee: 'gitee-token' } };
  const usernames = { testuser: { gitee: 'x-access-token' } };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens), { mode: 0o600 });
  fs.writeFileSync(USERNAMES_FILE, JSON.stringify(usernames), { mode: 0o600 });

  const stdin = 'protocol=https\nhost=gitee.com\npath=owner/repo.git\n\n';
  const out = runCredentialHelper(stdin);

  assert.ok(out.includes('username=x-access-token'), 'Gitee must use virtual username');
  assert.ok(out.includes('password=gitee-token'), 'must output Gitee token');

  teardown();
  console.log('✓ test_giteeStillUsesVirtualUsername passed');
}

function test_unknownHostEmitsNothing() {
  setup();

  const tokens = { testuser: { codehub: 'token' } };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens), { mode: 0o600 });

  const stdin = 'protocol=https\nhost=unknown.com\npath=owner/repo.git\n\n';
  const out = runCredentialHelper(stdin);

  assert.strictEqual(out.trim(), '', 'unknown host must emit nothing');

  teardown();
  console.log('✓ test_unknownHostEmitsNothing passed');
}

function test_outsideSessionCwdEmitsNothing() {
  setup();

  const tokens = { testuser: { github: 'token' } };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens), { mode: 0o600 });

  const stdin = 'protocol=https\nhost=github.com\npath=owner/repo.git\n\n';
  const out = runCredentialHelper(stdin, '/tmp/some-other-dir');

  assert.strictEqual(out.trim(), '', 'cwd outside session must emit nothing');

  teardown();
  console.log('✓ test_outsideSessionCwdEmitsNothing passed');
}

// ── Run ───────────────────────────────────────────────────────────────────────

test_codehubHostMapping();
test_codehubMissingUsername();
test_githubStillUsesVirtualUsername();
test_giteeStillUsesVirtualUsername();
test_unknownHostEmitsNothing();
test_outsideSessionCwdEmitsNothing();

console.log('\nAll git-credential-helper tests passed.\n');