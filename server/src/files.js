// Per-session file explorer backend. Pure module — no Express coupling.
// All public functions take an `absRoot` (the session's cwd, recomputed
// per request via resolveCwd) and a relative `relPath` rooted at absRoot.
// Containment is enforced inside this module; callers must NOT rely on
// their own path joining.
//
// Errors are tagged with `code` so routes can map them to HTTP statuses:
//   ERR_OUTSIDE         — path escapes absRoot (incl. via symlink)
//   ERR_NOT_FOUND       — file/dir missing
//   ERR_NOT_DIR         — listDir called on a file
//   ERR_BINARY          — read of a binary file (caller decides what to send)
//   ERR_TOO_LARGE       — read or write over MAX_READ_BYTES
//   ERR_MTIME_CONFLICT  — write expected a different mtime
//   ERR_SYMLINK_WRITE   — write target is a symlink (rejected unconditionally)
//   ERR_PERM            — EACCES / EPERM from the underlying syscall

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const MAX_READ_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const MAX_LIST_ENTRIES = 2000;
const HEAVY_DIRS = new Set([
  'node_modules', '.git', '.venv', '__pycache__', 'dist', 'build', '.next',
]);

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

// Resolve `relPath` against `absRoot` and assert containment. Follows
// symlinks via realpath and rejects if the target escapes the root.
// Returns the absolute resolved path.
async function safeJoin(absRoot, relPath) {
  const raw = (relPath == null ? '' : String(relPath)).trim();
  if (raw === '' || raw === '.' || raw === './') return absRoot;
  if (path.isAbsolute(raw)) throw err('ERR_OUTSIDE', 'path must be relative');
  const abs = path.resolve(absRoot, raw);
  const rel = path.relative(absRoot, abs);
  if (rel === '' ) return absRoot;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw err('ERR_OUTSIDE', 'path escapes session root');
  }
  // Symlink check: if any component is a symlink whose target escapes,
  // realpath will surface that. Don't realpath if the file doesn't exist
  // yet (e.g. write target's tmp suffix); only check when the file exists.
  let st;
  try {
    st = await fsp.lstat(abs);
  } catch (e) {
    if (e.code === 'ENOENT') return abs; // doesn't exist; treated by caller
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  if (st.isSymbolicLink()) {
    let real;
    try { real = await fsp.realpath(abs); }
    catch (e) {
      if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', 'symlink target missing');
      if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
      throw e;
    }
    const realRoot = await fsp.realpath(absRoot).catch(() => absRoot);
    const realRel = path.relative(realRoot, real);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw err('ERR_OUTSIDE', 'symlink target escapes session root');
    }
  }
  return abs;
}

async function listDir(absRoot, relPath) {
  const abs = await safeJoin(absRoot, relPath);
  let st;
  try { st = await fsp.stat(abs); }
  catch (e) {
    if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', 'directory missing');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  if (!st.isDirectory()) throw err('ERR_NOT_DIR', 'not a directory');

  let dirents;
  try { dirents = await fsp.readdir(abs, { withFileTypes: true }); }
  catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }

  const truncated = dirents.length > MAX_LIST_ENTRIES;
  if (truncated) dirents.length = MAX_LIST_ENTRIES;

  const entries = [];
  for (const d of dirents) {
    const childAbs = path.join(abs, d.name);
    let estat;
    try { estat = await fsp.lstat(childAbs); }
    catch { continue; } // skip entries we can't stat (EACCES, races)
    let kind;
    if (d.isDirectory()) kind = 'dir';
    else if (d.isFile()) kind = 'file';
    else if (d.isSymbolicLink()) kind = 'symlink';
    else kind = 'other';
    entries.push({
      name: d.name,
      kind,
      size: estat.size,
      mtime: estat.mtimeMs,
      heavy: kind === 'dir' && HEAVY_DIRS.has(d.name),
    });
  }
  entries.sort((a, b) => {
    if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const relOut = path.relative(absRoot, abs) || '.';
  return { path: relOut, entries, truncated };
}

function looksBinary(buf) {
  if (buf.length === 0) return false;
  let nonText = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 0x20) nonText++;
    else if (b > 0x7e && b < 0x80) nonText++;
  }
  return nonText / buf.length > 0.3;
}

async function readFile(absRoot, relPath) {
  const abs = await safeJoin(absRoot, relPath);
  let st;
  try { st = await fsp.stat(abs); }
  catch (e) {
    if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', 'file missing');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  if (st.isDirectory()) throw err('ERR_NOT_DIR', 'is a directory');
  if (st.size > MAX_READ_BYTES) {
    const e = err('ERR_TOO_LARGE', 'file exceeds max size');
    e.size = st.size; e.mtime = st.mtimeMs;
    throw e;
  }

  // Binary sniff first to avoid reading huge "text" files we can't render.
  let fh;
  try { fh = await fsp.open(abs, 'r'); }
  catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  try {
    const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, st.size));
    if (sniff.length > 0) await fh.read(sniff, 0, sniff.length, 0);
    if (looksBinary(sniff)) {
      const e = err('ERR_BINARY', 'binary file');
      e.size = st.size; e.mtime = st.mtimeMs;
      throw e;
    }
    // Read the whole file as UTF-8.
    const buf = Buffer.alloc(st.size);
    if (st.size > 0) await fh.read(buf, 0, st.size, 0);
    const relOut = path.relative(absRoot, abs);
    return {
      path: relOut,
      size: st.size,
      mtimeMs: st.mtimeMs,
      encoding: 'utf8',
      content: buf.toString('utf8'),
    };
  } finally {
    await fh.close().catch(() => {});
  }
}

async function writeFile(absRoot, relPath, { content, expectedMtimeMs }) {
  if (typeof content !== 'string') throw err('ERR_BAD_INPUT', 'content must be string');
  if (typeof expectedMtimeMs !== 'number' || !Number.isFinite(expectedMtimeMs)) {
    throw err('ERR_BAD_INPUT', 'expectedMtimeMs required');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
    throw err('ERR_TOO_LARGE', 'content exceeds max size');
  }

  const abs = await safeJoin(absRoot, relPath);

  // Existence + symlink + mtime checks.
  let st;
  try { st = await fsp.lstat(abs); }
  catch (e) {
    if (e.code === 'ENOENT') throw err('ERR_NOT_FOUND', 'file does not exist (no creates in v1)');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }
  if (st.isSymbolicLink()) throw err('ERR_SYMLINK_WRITE', 'refusing to write through symlink');
  if (!st.isFile()) throw err('ERR_NOT_FOUND', 'not a regular file');
  if (Math.abs(st.mtimeMs - expectedMtimeMs) > 1) {
    throw err('ERR_MTIME_CONFLICT', 'file changed on disk');
  }

  const dir = path.dirname(abs);
  const tmp = path.join(dir, '.' + path.basename(abs) + '.myco-tmp-' + crypto.randomBytes(4).toString('hex'));
  try {
    await fsp.writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 });
    try {
      await fsp.rename(tmp, abs);
    } catch (e) {
      if (e.code === 'EXDEV') {
        // Cross-device rename: fall back to copy + unlink. Not atomic but
        // shouldn't happen under /wks; log so we know if the bind-mount
        // ever crosses a filesystem.
        console.warn('[files] EXDEV on rename, falling back to non-atomic copy');
        await fsp.copyFile(tmp, abs);
        await fsp.unlink(tmp).catch(() => {});
      } else {
        throw e;
      }
    }
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    if (e.code === 'EACCES' || e.code === 'EPERM') throw err('ERR_PERM', e.message);
    throw e;
  }

  const newSt = await fsp.stat(abs);
  return { mtimeMs: newSt.mtimeMs, size: newSt.size };
}

module.exports = {
  safeJoin,
  listDir,
  readFile,
  writeFile,
  MAX_READ_BYTES,
};
