const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ptyMod = require('./pty');

// ─── workspace ───────────────────────────────────────────────────────────────

const WORKSPACE = (() => {
  const raw = (process.env.MYCO_WORKSPACE || os.homedir()).replace(/^~(?=$|\/)/, os.homedir());
  const resolved = path.resolve(raw);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
})();

const STATE_DIR = process.env.MYCO_STATE_DIR || path.join(os.homedir(), '.myco');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');

function userRoot(user) { return user ? path.join(WORKSPACE, user) : WORKSPACE; }
function workspaceName(user) {
  const base = path.basename(WORKSPACE) || 'workspace';
  return user ? `${base}/${user}` : base;
}
function getWorkspace() { return WORKSPACE; }

function listWorkspaceDirs(user) {
  const root = userRoot(user);
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

function resolveCwd(rawCwd, user) {
  const root = userRoot(user);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  const raw = (rawCwd || '').trim();
  if (!raw) return root;
  if (raw === '~' || raw.startsWith('~/') || path.isAbsolute(raw)) {
    throw new Error(`Path must be relative to your workspace`);
  }
  const abs = path.resolve(root, raw);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside your workspace`);
  }
  if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
  if (!fs.statSync(abs).isDirectory()) throw new Error(`Path is not a directory`);
  return abs;
}

function toRel(abs, user) {
  const rel = path.relative(userRoot(user), abs);
  return rel === '' ? '.' : rel;
}

// ─── session store (JSON file) ──────────────────────────────────────────────

let storeCache = null;
function loadStore() {
  if (storeCache) return storeCache;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    storeCache = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    storeCache = { sessions: {} };
  }
  if (!storeCache.sessions) storeCache.sessions = {};
  return storeCache;
}

function saveStore() {
  if (!storeCache) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(storeCache, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function putSession(rec) { loadStore().sessions[rec.id] = rec; saveStore(); }
function removeSession(id) { delete loadStore().sessions[id]; saveStore(); }
function getSessionRecord(id) { return loadStore().sessions[id] || null; }

// ─── claude transcript helpers ──────────────────────────────────────────────

function projectsDir() { return path.join(os.homedir(), '.claude', 'projects'); }
function encodeCwdForClaude(cwd) { return cwd.replace(/\//g, '-'); }

async function findNewestJsonl(dir, sinceMs = 0) {
  let entries;
  try { entries = await fsp.readdir(dir); } catch { return null; }
  let best = null;
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    let st;
    try { st = await fsp.stat(full); } catch { continue; }
    if (st.mtimeMs < sinceMs) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { file: f, full, mtimeMs: st.mtimeMs };
  }
  return best;
}

async function readFirstUserPrompt(jsonlPath) {
  try {
    const raw = await fsp.readFile(jsonlPath, 'utf8');
    for (const line of raw.split('\n').slice(0, 300)) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== 'user') continue;
      const c = obj.message && obj.message.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        const t = c.find((x) => x && x.type === 'text');
        if (t) text = t.text || '';
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (!text || text.startsWith('<')) continue;
      return text.length > 100 ? text.slice(0, 100) + '…' : text;
    }
    return null;
  } catch { return null; }
}

async function readCwdFromTranscript(jsonlPath) {
  try {
    const raw = await fsp.readFile(jsonlPath, 'utf8');
    for (const line of raw.split('\n').slice(0, 100)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj.cwd === 'string' && obj.cwd.startsWith('/')) return obj.cwd;
      } catch {}
    }
    return null;
  } catch { return null; }
}

async function readDescriptionForCwd(absCwd) {
  const dir = path.join(projectsDir(), encodeCwdForClaude(absCwd));
  const newest = await findNewestJsonl(dir);
  return newest ? readFirstUserPrompt(newest.full) : null;
}

// After spawning claude, poll the projects dir for a new jsonl whose mtime is
// >= the spawn time and stash the id (filename minus .jsonl) so we can
// `claude --resume <id>` on later attaches.
function captureClaudeSessionId(sessionId, absCwd, spawnedAtMs) {
  const dir = path.join(projectsDir(), encodeCwdForClaude(absCwd));
  let attempts = 0;
  const tick = async () => {
    attempts += 1;
    const newest = await findNewestJsonl(dir, spawnedAtMs - 500);
    if (newest) {
      const id = newest.file.replace(/\.jsonl$/, '');
      const rec = loadStore().sessions[sessionId];
      if (rec && !rec.claudeSessionId) {
        rec.claudeSessionId = id;
        saveStore();
      }
      return;
    }
    if (attempts < 60) setTimeout(tick, 500);
  };
  setTimeout(tick, 500);
}

// ─── public API ──────────────────────────────────────────────────────────────

function ownerOf(id) {
  const m = String(id || '').match(/^myco-([a-zA-Z0-9_-]+?)-[a-f0-9]+$/);
  return m ? m[1] : null;
}

function sessionBelongsToUser(sessionId, user) {
  return ownerOf(sessionId) === user;
}

function shortId() { return crypto.randomBytes(4).toString('hex'); }

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function listSessions(forUser) {
  const all = Object.values(loadStore().sessions);
  const filtered = forUser ? all.filter((r) => r.user === forUser) : all;
  return Promise.all(filtered.map(async (r) => ({
    id: r.id,
    name: r.id,
    cwd: r.cwd,
    description: await readDescriptionForCwd(r.absCwd),
    created_at: r.createdAt,
  })));
}

async function spawnSession(rawCwd, user = 'default', opts = {}) {
  const absCwd = resolveCwd(rawCwd, user);
  const dup = Object.values(loadStore().sessions).find((r) => r.user === user && r.absCwd === absCwd);
  if (dup) throw new Error(`A session already exists for "${toRel(absCwd, user)}"`);

  const safeUser = (user || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  const id = `myco-${safeUser}-${shortId()}`;
  const cols = clamp(opts.cols, 20, 300, 120);
  const rows = clamp(opts.rows, 10, 200, 30);
  const createdAt = new Date().toISOString();

  const record = { id, user, cwd: toRel(absCwd, user), absCwd, claudeSessionId: null, createdAt };
  putSession(record);

  const spawnedAt = Date.now();
  ptyMod.spawnClaude(id, { cwd: absCwd, cols, rows });
  captureClaudeSessionId(id, absCwd, spawnedAt);
  return { id, cwd: record.cwd };
}

function ensureLiveSession(sessionId) {
  const live = ptyMod.getSession(sessionId);
  if (live && live.alive) return live;
  const rec = getSessionRecord(sessionId);
  if (!rec) throw new Error(`unknown session: ${sessionId}`);
  return ptyMod.spawnClaude(sessionId, {
    cwd: rec.absCwd,
    resumeId: rec.claudeSessionId || null,
    cols: 120,
    rows: 30,
  });
}

function deleteSession(sessionId) {
  ptyMod.killSession(sessionId);
  removeSession(sessionId);
}

// One-shot importer: walk ~/.claude/projects/, find transcripts whose `cwd`
// lives under <WORKSPACE>/<user>/, and create a resumable session record for
// each cwd that doesn't already have one.
async function importExistingTranscripts() {
  const root = projectsDir();
  let dirs;
  try { dirs = await fsp.readdir(root); } catch { return 0; }

  const store = loadStore();
  const haveCwds = new Set(Object.values(store.sessions).map((s) => s.absCwd));
  let imported = 0;

  for (const d of dirs) {
    const dir = path.join(projectsDir(), d);
    let stat;
    try { stat = await fsp.stat(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const newest = await findNewestJsonl(dir);
    if (!newest) continue;

    const cwd = await readCwdFromTranscript(newest.full);
    if (!cwd) continue;
    if (haveCwds.has(cwd)) continue;

    const rel = path.relative(WORKSPACE, cwd);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const segs = rel.split(path.sep).filter(Boolean);
    if (segs.length < 1) continue;
    const user = segs[0].replace(/[^a-zA-Z0-9_-]/g, '');
    if (!user) continue;
    const userRel = segs.slice(1).join('/') || '.';

    const id = `myco-${user}-${shortId()}`;
    store.sessions[id] = {
      id,
      user,
      cwd: userRel,
      absCwd: cwd,
      claudeSessionId: newest.file.replace(/\.jsonl$/, ''),
      createdAt: new Date(newest.mtimeMs).toISOString(),
    };
    haveCwds.add(cwd);
    imported += 1;
  }

  if (imported) saveStore();
  return imported;
}

module.exports = {
  WORKSPACE,
  getWorkspace,
  workspaceName,
  listWorkspaceDirs,
  listSessions,
  spawnSession,
  ensureLiveSession,
  sessionBelongsToUser,
  deleteSession,
  ownerOf,
  importExistingTranscripts,
};
