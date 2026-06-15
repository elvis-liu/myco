// Git username storage for CodeHub and other providers.
//
// On disk: $MYCO_STATE_DIR/git-usernames.json, mode 0600.
//
// Shape:
//   {
//     "<myco-user>": {
//       "github": "x-access-token",     // virtual value (GitHub ignores username)
//       "gitee": "x-access-token",      // virtual value (Gitee ignores username)
//       "codehub": "<real-username>"    // from PAT login API response
//     }
//   }
//
// Why this file (vs extending git-tokens.json):
//   - Username and token are different in nature: token is secret, username is public identifier
//   - git-tokens.json structure is stable and referenced by multiple modules
//   - Future providers may need more metadata (SSH keys, etc.) — separate file is more flexible

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = process.env.MYCO_STATE_DIR || path.join(os.homedir(), '.myco');
const FILE = path.join(STATE_DIR, 'git-usernames.json');

const KNOWN_PROVIDERS = new Set(['github', 'gitee', 'codehub']);

let _cache = null;

function _load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!_cache || typeof _cache !== 'object') _cache = {};
  } catch {
    _cache = {};
  }
  return _cache;
}

function _persist() {
  if (!_cache) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch {}
}

function _normalizeProvider(provider) {
  const p = String(provider || '').toLowerCase();
  return KNOWN_PROVIDERS.has(p) ? p : null;
}

// Get git username for (user, provider). Returns null if not found.
function getUsername(user, provider) {
  if (!user) return null;
  const p = _normalizeProvider(provider);
  if (!p) return null;
  const store = _load();
  const entry = store[user];
  if (!entry || typeof entry !== 'object') return null;
  return entry[p] || null;
}

// Store git username for (user, provider).
// For github/gitee, use virtual value 'x-access-token'.
// For codehub, use the real username from PAT login API.
function setUsername(user, provider, username) {
  if (!user || !username) throw new Error('user and username required');
  const p = _normalizeProvider(provider);
  if (!p) throw new Error(`unknown provider: ${provider}`);
  const store = _load();
  if (!store[user] || typeof store[user] !== 'object') store[user] = {};
  store[user][p] = String(username).trim();
  _persist();
}

// Remove username for (user, provider). Idempotent; returns false if not found.
function removeUsername(user, provider) {
  if (!user) return false;
  const p = _normalizeProvider(provider);
  if (!p) return false;
  const store = _load();
  const entry = store[user];
  if (!entry || typeof entry !== 'object') return false;
  if (!(p in entry)) return false;
  delete entry[p];
  _persist();
  return true;
}

// List all usernames for a user. Returns { github, gitee, codehub } with values or null.
function listAll(user) {
  if (!user) return { github: null, gitee: null, codehub: null };
  const store = _load();
  const entry = store[user];
  if (!entry || typeof entry !== 'object') {
    return { github: null, gitee: null, codehub: null };
  }
  return {
    github: entry.github || null,
    gitee: entry.gitee || null,
    codehub: entry.codehub || null,
  };
}

// Test-only: drop the in-memory cache.
function _resetCacheForTest() { _cache = null; }

module.exports = {
  getUsername,
  setUsername,
  removeUsername,
  listAll,
  KNOWN_PROVIDERS,
  _resetCacheForTest,
  _file: () => FILE,
};