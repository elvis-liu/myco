// Token store. Two env vars are accepted:
//   MYCO_TOKEN=<tok>                  → single anonymous user "default"
//   MYCO_TOKENS=alice:abc,bob:def     → multi-user; each user gets their own scope
// If neither is set, auth is disabled (everyone is "default").

const TOKENS = new Map(); // token -> username

if (process.env.MYCO_TOKEN) {
  TOKENS.set(process.env.MYCO_TOKEN, 'default');
}
if (process.env.MYCO_TOKENS) {
  for (const pair of process.env.MYCO_TOKENS.split(',')) {
    const idx = pair.indexOf(':');
    if (idx < 1) continue;
    const user = sanitize(pair.slice(0, idx).trim());
    const tok = pair.slice(idx + 1).trim();
    if (user && tok) TOKENS.set(tok, user);
  }
}

const AUTH_REQUIRED = TOKENS.size > 0;

function sanitize(user) {
  return user.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
}

function userFromToken(tok) {
  if (!AUTH_REQUIRED) return 'default';
  return TOKENS.get(tok) || null;
}

function userFromRequest(req) {
  if (!AUTH_REQUIRED) return 'default';
  const auth = req.headers.authorization || '';
  const headerTok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const queryTok = (req.query && req.query.token) || '';
  return userFromToken(headerTok || queryTok);
}

// ── share tokens ────────────────────────────────────────────────────────────
// In-memory: lost on restart. Tokens are read-only viewer credentials for a
// single session, used in shareable URLs like /?s=<token>.
const crypto = require('crypto');
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const shareTokens = new Map(); // token -> { sessionId, owner, expiresAt }

function gcShareTokens() {
  const now = Date.now();
  for (const [tok, info] of shareTokens) {
    if (info.expiresAt < now) shareTokens.delete(tok);
  }
}

function createShareToken(sessionId, owner) {
  gcShareTokens();
  // Reuse the existing valid token for this (sessionId, owner) pair so the
  // share URL stays stable across re-shares until it expires.
  for (const [tok, info] of shareTokens) {
    if (info.sessionId === sessionId && info.owner === owner) {
      return { token: tok, expiresAt: info.expiresAt };
    }
  }
  const token = crypto.randomBytes(18).toString('base64url');
  const expiresAt = Date.now() + SHARE_TTL_MS;
  shareTokens.set(token, { sessionId, owner: owner || 'default', expiresAt });
  return { token, expiresAt };
}

function shareTokenInfo(tok) {
  if (!tok) return null;
  const info = shareTokens.get(tok);
  if (!info) return null;
  if (info.expiresAt < Date.now()) { shareTokens.delete(tok); return null; }
  return info;
}

function revokeShareTokensForSession(sessionId) {
  for (const [tok, info] of shareTokens) {
    if (info.sessionId === sessionId) shareTokens.delete(tok);
  }
}

module.exports = {
  AUTH_REQUIRED,
  userFromToken,
  userFromRequest,
  createShareToken,
  shareTokenInfo,
  revokeShareTokensForSession,
};
