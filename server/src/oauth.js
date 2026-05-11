// GitHub OAuth helpers — used by the /auth/github/{start,callback} routes.
//
// Reads three env vars (via $STATE_DIR/.env, sourced by docker-entrypoint.sh):
//   MYCO_GH_CLIENT_ID
//   MYCO_GH_CLIENT_SECRET
//   MYCO_PUBLIC_ORIGIN     e.g. https://myco.labxnow.ai
//
// Test seam: when MYCO_TEST_OAUTH_BYPASS=<login> is set, exchangeCode() and
// fetchUser() return canned values for that login without contacting GitHub.
// This lets test.sh exercise the callback handler end-to-end without a real
// OAuth round-trip or network egress from the container.

const SCOPES = 'read:user user:email repo';

function _bypassLogin() {
  const v = String(process.env.MYCO_TEST_OAUTH_BYPASS || '').trim();
  return v || null;
}

function isConfigured() {
  if (_bypassLogin()) return true;
  return !!(process.env.MYCO_GH_CLIENT_ID && process.env.MYCO_GH_CLIENT_SECRET && process.env.MYCO_PUBLIC_ORIGIN);
}

function publicOrigin() {
  return String(process.env.MYCO_PUBLIC_ORIGIN || '').replace(/\/+$/, '');
}

function callbackUrl() {
  return `${publicOrigin()}/auth/github/callback`;
}

function startUrl(state) {
  const clientId = process.env.MYCO_GH_CLIENT_ID || '';
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(),
    scope: SCOPES,
    state,
    allow_signup: 'false',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

async function exchangeCode(code) {
  const bypass = _bypassLogin();
  if (bypass) {
    // Pass the requested login through the access_token so a single test
    // container can mint sessions for several users (each test calls
    // /auth/github/callback with code=<login>). If the test sends a real
    // OAuth-shaped code (non-alphanumeric / too long), fall back to the
    // bypass env var so existing simple tests still work.
    const usableCode = /^[a-zA-Z0-9_-]{1,24}$/.test(String(code || '')) ? code : bypass;
    return { access_token: `test-token-${usableCode}`, token_type: 'bearer', scope: SCOPES };
  }

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'myco/1.0',
    },
    body: JSON.stringify({
      client_id: process.env.MYCO_GH_CLIENT_ID,
      client_secret: process.env.MYCO_GH_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(),
    }),
  });
  if (!res.ok) throw new Error(`github token exchange failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.access_token) throw new Error(`github token exchange returned no access_token: ${body.error || ''}`);
  return body;
}

async function fetchUser(accessToken) {
  const bypass = _bypassLogin();
  if (bypass) {
    // Parse `test-token-<login>` if present; else use the bypass env value.
    const m = String(accessToken || '').match(/^test-token-([a-zA-Z0-9_-]{1,24})$/);
    const login = m ? m[1] : bypass;
    return {
      login,
      id: 100000 + login.split('').reduce((a, c) => a + c.charCodeAt(0), 0),
      name: login,
      avatar_url: '',
      email: `${login}@example.test`,
    };
  }

  const res = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `token ${accessToken}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'myco/1.0',
    },
  });
  if (!res.ok) throw new Error(`github /user failed: HTTP ${res.status}`);
  return res.json();
}

module.exports = {
  isConfigured,
  publicOrigin,
  callbackUrl,
  startUrl,
  exchangeCode,
  fetchUser,
  SCOPES,
};
