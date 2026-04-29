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

module.exports = { AUTH_REQUIRED, userFromToken, userFromRequest };
