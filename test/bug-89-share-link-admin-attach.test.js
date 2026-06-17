// bug-89 regression: share-link viewers who are admins must reconnect with
// full owner privileges, not readonly.
//
// Root cause: in server/src/index.js WS upgrade handler, the share-token
// branch (lines 761-779) unconditionally set readOnly=true, even for
// authenticated users who had been granted admin via /admin. When such a
// user's WS was kicked by addAdminToSession, the reconnect still landed
// them on the viewer branch because the share-token path never checked
// rec.admins.
//
// Fix: in the share-link branch, when viewerUser is present (authenticated
// viewer), check isOwnerOrAdmin(sessionId, viewerUser) and clear readOnly
// if true. This mirrors the non-share branch's admin exception.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-89: share-link admin gets owner-tier attach ──');

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards on the prod source.

t('static guard: index.js share-link branch checks isOwnerOrAdmin for authenticated viewer', () => {
  const src = _read('server/src/index.js');
  // Look for the bug-89 comment marker in the share-link branch
  const bugMarker = src.indexOf('bug-89: share-link viewers who are admins');
  assert.ok(bugMarker > 0, 'share-link branch must have bug-89 comment marker');
  // The fix: check isOwnerOrAdmin when viewerUser exists
  // Search near the marker for the key patterns (use larger window to include the actual call)
  const contextStart = Math.max(0, bugMarker - 100);
  const contextEnd = Math.min(src.length, bugMarker + 1200);
  const context = src.slice(contextStart, contextEnd);
  assert.ok(/isOwnerOrAdmin\s*\(/.test(context),
    'share-link branch must call isOwnerOrAdmin to check admin privilege for authenticated viewers');
  assert.ok(/viewerUser/.test(context),
    'share-link branch must reference viewerUser (authenticated viewer identity)');
  assert.ok(/readOnly\s*=\s*false/.test(context),
    'share-link branch must set readOnly=false for admin viewers');
});

t('static guard: share-link branch still sets readOnly=true for anonymous viewers', () => {
  const src = _read('server/src/index.js');
  const bugMarker = src.indexOf('bug-89: share-link viewers who are admins');
  const contextStart = Math.max(0, bugMarker - 100);
  const contextEnd = Math.min(src.length, bugMarker + 1200);
  const context = src.slice(contextStart, contextEnd);
  // Anonymous path: else branch inside viewerUser check
  assert.ok(/readOnly\s*=\s*true/.test(context),
    'share-link branch must still set readOnly=true for anonymous viewers (no auth token)');
});

t('static guard: share-link branch sets readOnly=true for authenticated non-admin viewers', () => {
  const src = _read('server/src/index.js');
  const bugMarker = src.indexOf('bug-89: share-link viewers who are admins');
  const contextStart = Math.max(0, bugMarker - 100);
  const contextEnd = Math.min(src.length, bugMarker + 1200);
  const context = src.slice(contextStart, contextEnd);
  // Non-admin authenticated viewer: else branch inside isOwnerOrAdmin check
  // Should show readOnly=false in one place, readOnly=true in another
  const falseMatches = context.match(/readOnly\s*=\s*false/g) || [];
  const trueMatches = context.match(/readOnly\s*=\s*true/g) || [];
  assert.ok(falseMatches.length >= 1 && trueMatches.length >= 1,
    'share-link branch must have both readOnly=false (admin) and readOnly=true (non-admin) paths');
});

// ──────────────────────────────────────────────────────────────────────────
// Logic simulation tests (inlined fixed behavior).

// Simulates the FIXED share-link branch decision logic.
function shareLinkAttachDecision(viewerUser, opts = {}) {
  const { isAuthRequired, isOwnerOrAdmin } = opts;
  if (!viewerUser) {
    // Anonymous viewer → always readonly
    return { readOnly: true, user: 'anon' };
  }
  // Authenticated viewer
  if (isAuthRequired && isOwnerOrAdmin(viewerUser)) {
    // Admin via share-link → owner-tier attach
    return { readOnly: false, user: viewerUser };
  } else {
    // Non-admin authenticated viewer → readonly
    return { readOnly: true, user: viewerUser };
  }
}

t('share-link logic: anonymous viewer → readOnly=true', () => {
  const result = shareLinkAttachDecision(null, {});
  assert.strictEqual(result.readOnly, true);
  assert.strictEqual(result.user, 'anon');
});

t('share-link logic: authenticated non-admin viewer → readOnly=true', () => {
  const result = shareLinkAttachDecision('bob', {
    isAuthRequired: true,
    isOwnerOrAdmin: (u) => u === 'alice', // alice is admin, bob is not
  });
  assert.strictEqual(result.readOnly, true);
  assert.strictEqual(result.user, 'bob');
});

t('share-link logic: authenticated admin viewer → readOnly=false', () => {
  const result = shareLinkAttachDecision('alice', {
    isAuthRequired: true,
    isOwnerOrAdmin: (u) => u === 'alice', // alice is admin
  });
  assert.strictEqual(result.readOnly, false, 'admin via share-link must get owner-tier attach (readOnly=false)');
  assert.strictEqual(result.user, 'alice');
});

t('share-link logic: owner of session → readOnly=false', () => {
  // Owner is implicitly admin (rec.user === user), so isOwnerOrAdmin returns true
  const result = shareLinkAttachDecision('kkrazy', {
    isAuthRequired: true,
    isOwnerOrAdmin: (u) => u === 'kkrazy', // kkrazy is session owner
  });
  assert.strictEqual(result.readOnly, false, 'owner viewing via share-link must get owner-tier attach');
  assert.strictEqual(result.user, 'kkrazy');
});

t('share-link logic: authRequired=false → authenticated viewer still readonly (no admin check)', () => {
  // In single-user dev mode, isAuthRequired=false skips the admin check
  // This is consistent with the non-share branch behavior
  const result = shareLinkAttachDecision('alice', {
    isAuthRequired: false,
    isOwnerOrAdmin: (u) => u === 'alice',
  });
  assert.strictEqual(result.readOnly, true, 'dev mode (authRequired=false) → readonly regardless of admin status');
  assert.strictEqual(result.user, 'alice');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);