#!/usr/bin/env bash
# Snapshot the local mycod log buffer into _myco_/logs/ for periodic
# analysis (paired with the /loop scheduled tick that consumes it).
#
# How it works:
#   - The local server's `/logs?n=N` endpoint returns its in-memory
#     rolling buffer (server/src/logCapture.js, CAPACITY=500). We
#     poll it, dedup against what's already on disk (by ts+msg), and
#     append the new lines to a per-UTC-day file under _myco_/logs/.
#   - Auth bearer is read from /data/auth-sessions.json — pick the
#     latest unexpired session for `kkrazy`.
#
# Usage:
#   ./collect-logs.sh               # default: 500 entries, dedup append
#   ./collect-logs.sh --n 1000      # ask for more from /logs?n=
#
# Designed to be safe under cron / a /loop tick. No SSH, no mycobeta.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="${DIR}/_myco_/logs"
MARKER="${LOGS_DIR}/.last-fetch"

PORT="${MYCO_PORT:-3000}"
AUTH_FILE="${MYCO_AUTH_FILE:-/data/auth-sessions.json}"
LOGIN="${MYCO_LOG_LOGIN:-kkrazy}"
N="500"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --n)         N="$2"; shift 2 ;;
    --login)     LOGIN="$2"; shift 2 ;;
    --auth-file) AUTH_FILE="$2"; shift 2 ;;
    --port)      PORT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOGS_DIR"

# ── pick a usable bearer ─────────────────────────────────────────────────────
# Newest unexpired auth-sessions.json entry whose login matches. Node is
# already on PATH (mycod container) — avoid shelling out to jq which the
# container may not have.
pick_token() {
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const login = process.argv[2];
    let store; try { store = JSON.parse(fs.readFileSync(path, "utf8")); }
    catch (e) { process.stderr.write("auth-sessions read failed: " + e.message + "\n"); process.exit(1); }
    const now = Date.now();
    let bestTok = null, bestExp = -1;
    for (const [tok, rec] of Object.entries(store)) {
      if (!rec || rec.login !== login) continue;
      if (typeof rec.expiresAt !== "number" || rec.expiresAt <= now) continue;
      if (rec.expiresAt > bestExp) { bestExp = rec.expiresAt; bestTok = tok; }
    }
    if (!bestTok) { process.stderr.write("no unexpired session for login=" + login + "\n"); process.exit(2); }
    process.stdout.write(bestTok);
  ' "$AUTH_FILE" "$LOGIN"
}

token="$(pick_token)"
if [[ -z "$token" ]]; then
  echo "[collect-logs] no usable bearer token — aborting" >&2
  exit 1
fi

now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
day="$(date -u +%Y-%m-%d)"
outfile="${LOGS_DIR}/mycod-${day}.log"

# ── fetch ────────────────────────────────────────────────────────────────────
fresh_json="$(mktemp)"
trap 'rm -f "$fresh_json"' EXIT

http_code="$(curl -sS -o "$fresh_json" -w '%{http_code}' \
  -H "Authorization: Bearer $token" \
  "http://127.0.0.1:${PORT}/logs?n=${N}")" || { echo "[collect-logs] curl failed" >&2; exit 1; }

if [[ "$http_code" != "200" ]]; then
  echo "[collect-logs] /logs returned HTTP ${http_code}: $(head -c 200 "$fresh_json")" >&2
  exit 1
fi

# ── flatten JSON to "ts\tlevel\tmsg" lines, dedup against existing file ──────
fresh_flat="$(mktemp)"
node -e '
  const fs = require("fs");
  const entries = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(entries)) { process.exit(0); }
  for (const e of entries) {
    if (!e || !e.ts) continue;
    // Newlines in msg → spaces so one-line-per-entry stays valid.
    const msg = String(e.msg || "").replace(/\r?\n/g, " ⏎ ");
    process.stdout.write(`${e.ts}\t${e.level || "info"}\t${msg}\n`);
  }
' "$fresh_json" > "$fresh_flat"

# Existing-file keys (ts + level + msg). Awk match runs in linear scan;
# files stay one-day-per-file so size is bounded.
appended=0
if [[ -s "$outfile" ]]; then
  comm -23 \
    <(sort -u "$fresh_flat") \
    <(sort -u "$outfile") \
    > "${fresh_flat}.new"
  mv "${fresh_flat}.new" "$fresh_flat"
fi

if [[ -s "$fresh_flat" ]]; then
  # Append in chronological order. The /logs endpoint returns in order
  # already, but the dedup step ran through `sort` so we re-sort by ts.
  sort -k1,1 "$fresh_flat" >> "$outfile"
  appended="$(wc -l < "$fresh_flat" | tr -d ' ')"
fi

rm -f "$fresh_flat"
echo "$now_iso" > "$MARKER"

echo "[collect-logs] +${appended} new lines → ${outfile}  (fetched ${N}, login=${LOGIN})"
