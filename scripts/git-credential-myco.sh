#!/bin/sh
# bug-81: git credential helper that bridges myco's token store
# (/data/git-tokens.json — managed by server/src/git-tokens.js) to git's
# credential.fill protocol.
#
# Pre-fix, the myco token store and git's credential resolution were
# entirely disjoint. The user runs `/setpat <token>` (or signs in via
# OAuth) → the token lands in /data/git-tokens.json — but git's
# credential resolution chain (credential.helper → ~/.git-credentials →
# interactive prompt) has no awareness of that file, so `git push`
# either prompts for a password (failing in non-interactive
# environments with "could not read Username") or falls through
# silently and rejects the auth.
#
# Post-fix this helper is registered via `git config --global
# credential.helper /path/to/git-credential-myco.sh` (done at container
# boot in docker/docker-entrypoint.sh). Every HTTPS git operation
# against github.com / gitee.com / codehub-y.huawei.com then transparently
# picks up the stored token.
#
# Git's credential-fill protocol:
#   git invokes us with the action as $1 ("get" | "store" | "erase").
#   For "get", git writes key=value lines on stdin (protocol=https,
#   host=github.com, path=owner/repo.git, ...) followed by a blank line,
#   then expects us to write `username=...\npassword=...\n` on stdout (or
#   emit nothing → git falls through to the next helper / prompt).
#
# Per-user disambiguation:
#   /data/git-tokens.json is keyed by myco-user, but git the CLI
#   doesn't know which myco-user it's running for. We derive the user
#   from cwd by matching /wks/<user>/<session-id>/... — the documented
#   session storage layout. Sessions ALWAYS run with cwd inside their
#   workspace, so this is correct for any git invocation that
#   originates from a session.
#
# Outside a session cwd (e.g. user shelled into the container manually
# and `cd /tmp; git push`), the helper emits nothing → safe fallthrough.

set -eu

ACTION="${1:-get}"

# Only the "get" action looks up credentials. "store" + "erase" are
# no-ops — git invokes them after auth succeeds / fails respectively,
# and we don't need to react (the token store is managed by /setpat +
# OAuth, not by individual push attempts).
if [ "$ACTION" != "get" ]; then
  exit 0
fi

# Read git's stdin into a tmpfile so node can parse it.
# stdin = key=value lines until EOF (or blank line).
STDIN_TMP=$(mktemp)
trap 'rm -f "$STDIN_TMP"' EXIT INT TERM
cat > "$STDIN_TMP"

# Derive myco-user from cwd. /wks/<user>/<session-id>/...
# Cwd is the dir git was invoked from (or `git -C <dir>`'s target).
MYCO_CWD="$(pwd)"

# State dir defaults match server/src/git-tokens.js — MYCO_STATE_DIR
# override first, fall back to /data (the documented container layout
# per CLAUDE.md).
STATE_DIR="${MYCO_STATE_DIR:-/data}"
TOKENS_FILE="$STATE_DIR/git-tokens.json"
USERNAMES_FILE="$STATE_DIR/git-usernames.json"

# Debug logging: enable with MYCO_CRED_DEBUG=1
DEBUG="${MYCO_CRED_DEBUG:-0}"
log_debug() {
  if [ "$DEBUG" = "1" ]; then
    echo "[git-credential-myco] $1" >&2
  fi
}

log_debug "cwd=$MYCO_CWD state_dir=$STATE_DIR action=$ACTION"

# Delegate the lookup to node — robust JSON parsing + the same
# per-repo→user-level precedence the server uses. Helper emits
# nothing if any step fails (no tokens file, no matching token, cwd
# outside a session) → git falls through cleanly.
#
# Env vars must precede `node` — shell positional args land at
# process.argv, not process.env. Original v1 of this script had them
# after the closing `'`, which silently produced empty output (the
# node body read undefined for every env var and exited via the
# emit()-and-return path).

_node_script() {
MYCO_TOKENS_FILE="$TOKENS_FILE" \
MYCO_USERNAMES_FILE="$USERNAMES_FILE" \
MYCO_CWD="$MYCO_CWD" \
MYCO_STDIN_PATH="$STDIN_TMP" \
MYCO_CRED_DEBUG="$DEBUG" \
node -e '
const fs = require("fs");

const tokensFile = process.env.MYCO_TOKENS_FILE;
const usernamesFile = process.env.MYCO_USERNAMES_FILE;
const myCwd = process.env.MYCO_CWD;
const stdinPath = process.env.MYCO_STDIN_PATH;
const debug = process.env.MYCO_CRED_DEBUG === "1";

function log(msg) {
  if (debug) console.error("[git-credential-myco:node] " + msg);
}

function emit() { log("emit: no credential found"); }

// 1. Derive myco-user from cwd: /wks/<user>/...
//    Any other shape → emit nothing.
log("cwd=" + myCwd);
const cwdMatch = String(myCwd || "").match(/\/wks\/([^/]+)\//);
if (!cwdMatch) { log("cwd does not match /wks/<user>/ pattern"); emit(); process.exit(0); }
const mycoUser = cwdMatch[1];
log("mycoUser=" + mycoUser);

// 2. Parse git stdin (key=value lines).
let raw;
try { raw = fs.readFileSync(stdinPath, "utf8"); } catch { log("failed to read stdin file"); emit(); process.exit(0); }
log("stdin=" + raw.trim());
const ctx = {};
for (const line of raw.split("\n")) {
  const eq = line.indexOf("=");
  if (eq <= 0) continue;
  ctx[line.slice(0, eq)] = line.slice(eq + 1);
}

// 3. Map host → provider. github.com → github; gitee.com → gitee; codehub → codehub.
//    Anything else → emit nothing (provider not supported by myco).
const host = String(ctx.host || "").toLowerCase();
log("host=" + host);
let provider = null;
if (host === "github.com" || host.endsWith(".github.com")) provider = "github";
else if (host === "gitee.com" || host.endsWith(".gitee.com")) provider = "gitee";
else if (host === "codehub-y.huawei.com") provider = "codehub";
if (!provider) { log("unknown host, no provider mapping"); emit(); process.exit(0); }
log("provider=" + provider);

// 4. Load the token store. Tolerate missing file (no /setpat yet).
log("tokensFile=" + tokensFile);
let store;
try { store = JSON.parse(fs.readFileSync(tokensFile, "utf8")); }
catch (e) { log("failed to read tokens file: " + e.message); emit(); process.exit(0); }
const userEntry = store && store[mycoUser];
if (!userEntry || typeof userEntry !== "object") { log("no entry for user " + mycoUser); emit(); process.exit(0); }
log("userEntry keys: " + Object.keys(userEntry).join(", "));

// Load usernames store for CodeHub (real username required).
log("usernamesFile=" + usernamesFile);
let usernames = null;
try { usernames = JSON.parse(fs.readFileSync(usernamesFile, "utf8")); } catch (e) { log("failed to read usernames file: " + e.message); }
const usernameEntry = usernames && usernames[mycoUser];
log("usernameEntry for " + mycoUser + ": " + JSON.stringify(usernameEntry || {}));

// 5. Parse path → owner/repo for the per-repo lookup. Git sends
//    path=owner/repo.git OR path=owner/repo. Strip .git suffix.
//    If path missing / malformed → fall back to user-level only.
let token = null;
const cleanPath = String(ctx.path || "").replace(/\.git$/, "").replace(/^\/+/, "");
const parts = cleanPath.split("/").filter(Boolean);
log("path=" + ctx.path + " → cleanPath=" + cleanPath + " → parts=" + parts.join("/"));
if (parts.length >= 2) {
  const owner = parts[0];
  const repo = parts[1];
  // Per-repo PAT first (matches git-tokens.js getToken precedence).
  const repoKey = provider + "/" + owner + "/" + repo;
  log("checking repoKey=" + repoKey);
  if (userEntry[repoKey]) token = userEntry[repoKey];
}
// User-level fallback (bare provider key).
if (!token && userEntry[provider]) {
  log("checking user-level provider key=" + provider);
  token = userEntry[provider];
}

if (!token) { log("no token found for provider=" + provider); emit(); process.exit(0); }
log("found token (last4)=" + token.slice(-4));

// 6. Emit the credential lines.
//    GitHub/Gitee: x-access-token (server ignores username, uses token as password)
//    CodeHub: real username from git-usernames.json (required for auth)
let gitUsername;
if (provider === "github" || provider === "gitee") {
  gitUsername = "x-access-token";
} else if (provider === "codehub") {
  gitUsername = usernameEntry && usernameEntry[provider];
  if (!gitUsername) { log("no username for codehub in usernames file"); emit(); process.exit(0); }  // missing username → fallback
}
log("emitting username=" + gitUsername + " password(last4)=" + token.slice(-4));
process.stdout.write("username=" + gitUsername + "\n");
process.stdout.write("password=" + token + "\n");
' || true
}

# Run node script: debug mode shows stderr, normal mode suppresses stderr
if [ "$DEBUG" = "1" ]; then
  _node_script
else
  _node_script 2>/dev/null
fi

# Always exit 0. Git treats non-zero as "this helper crashed, skip its
# output entirely" — we want it to use whatever we DID print even if
# node hiccupped on something tangential.
exit 0
