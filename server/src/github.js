// GitHub integration: per-user PAT storage + issue creation.
//
// Tokens live in $MYCO_STATE_DIR/gh-tokens.json keyed by myco username.
// File mode is 0600 so it's only readable by the mycod process owner.
// (Plain on-disk storage; relies on filesystem permissions, not encryption.
// An attacker with read access to the state dir can read the tokens, same
// as any other secret in the .env file.)

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');

const STATE_DIR = process.env.MYCO_STATE_DIR || path.join(os.homedir(), '.myco');
const TOKENS_FILE = path.join(STATE_DIR, 'gh-tokens.json');

let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    if (!_cache || typeof _cache !== 'object') _cache = {};
  } catch {
    _cache = {};
  }
  return _cache;
}

function persist() {
  if (!_cache) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = TOKENS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2), { mode: 0o600 });
  // Renames preserve target file's mode if it exists; explicit chmod after
  // ensures fresh files also get 0600.
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, TOKENS_FILE);
  try { fs.chmodSync(TOKENS_FILE, 0o600); } catch {}
}

function getToken(user) {
  if (!user) return null;
  const store = load();
  return store[user] || null;
}

function setToken(user, token) {
  if (!user || !token) throw new Error('user and token required');
  const store = load();
  store[user] = String(token).trim();
  persist();
}

function clearToken(user) {
  if (!user) return false;
  const store = load();
  if (!(user in store)) return false;
  delete store[user];
  persist();
  return true;
}

function hasToken(user) {
  return !!getToken(user);
}

// Detect the GitHub owner/repo for an absolute cwd by reading its git
// remote. Uses the git CLI; returns null if cwd isn't a repo or has no
// github.com remote.
function detectRepo(absCwd) {
  return new Promise((resolve) => {
    if (!absCwd) return resolve(null);
    execFile('git', ['-C', absCwd, 'remote', 'get-url', 'origin'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      const url = String(stdout || '').trim();
      // Match git@github.com:OWNER/REPO(.git)? OR https://github.com/OWNER/REPO(.git)?
      const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\s*$/i);
      if (!m) return resolve(null);
      resolve({ owner: m[1], repo: m[2] });
    });
  });
}

// Create a GitHub issue via REST. Resolves to { number, url } on success,
// or { error, status } on failure. Never throws.
function createIssue({ token, owner, repo, title, body, labels }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      title: String(title || '').slice(0, 250),
      body: String(body || ''),
      labels: Array.isArray(labels) ? labels : undefined,
    });
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'myco/1.0',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d.toString(); });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(chunks); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && parsed.number) {
          resolve({ number: parsed.number, url: parsed.html_url });
        } else {
          resolve({
            error: parsed.message || `GitHub API ${res.statusCode}`,
            status: res.statusCode,
          });
        }
      });
    });
    req.on('error', (err) => resolve({ error: err.message, status: 0 }));
    req.on('timeout', () => { try { req.destroy(); } catch {}; resolve({ error: 'timeout', status: 0 }); });
    req.write(payload);
    req.end();
  });
}

module.exports = {
  getToken, setToken, clearToken, hasToken,
  detectRepo, createIssue,
};
