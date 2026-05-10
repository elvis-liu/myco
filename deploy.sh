#!/usr/bin/env bash
# Deploy myco to myco.labxnow.ai via Docker image.
#
# Canonical layout: ALL persistent state lives under a single host directory
# ($MYCO_STATE_DIR), bind-mounted into the container as:
#
#   $MYCO_STATE_DIR        → /data    (sessions.json, .env, caddy/, …)
#   $MYCO_STATE_DIR/home   → /root    (claude config: .claude/, .claude.json)
#   $MYCO_STATE_DIR/wks    → /wks     (workspaces)
#   $MYCO_STATE_DIR/Caddyfile → /etc/caddy/Caddyfile
#
# A redeploy is just `docker rm + docker run` against the same state dir;
# nothing lives in unnamed/named docker volumes.
#
# Usage:
#   ./deploy.sh                     # full deploy (test → build → ship → swap → verify)
#   ./deploy.sh --skip-tests        # skip the pre-flight smoke test
#   ./deploy.sh --dry-run           # plan only; no image transfer or swap
#   ./deploy.sh --add-token u:tok   # add/rotate one token in $STATE_DIR/.env and hot-reload (no build/ship)
#   MYCO_DEPLOY_HOST=user@host \
#   MYCO_STATE_DIR=/path/on/remote ./deploy.sh
set -euo pipefail

# ─── config ──────────────────────────────────────────────────────────────────
REMOTE="${MYCO_DEPLOY_HOST:-kkrazy@myco.labxnow.ai}"
IMAGE="${MYCO_IMAGE_TAG:-myco:latest}"
NAME="${MYCO_CONTAINER:-myco}"
STATE_DIR="${MYCO_STATE_DIR:-/home/kkrazy/myco-state}"
DEFAULT_TOKEN="${MYCO_DEFAULT_TOKEN:-admin:think4omni}"
SKIP_TESTS=0
DRY_RUN=0
ADD_TOKEN=""

# Populated by open_ssh + build_image; consumed by later steps.
SOCK=""
LOCAL_ID=""

# ─── helpers ─────────────────────────────────────────────────────────────────
step()   { printf "\n── %s ──\n" "$*"; }
ok()     { printf "  ✓ %s\n" "$*"; }
die()    { printf "  ✗ %s\n" "$*" >&2; exit 1; }

remote()     { ssh -o ControlPath="$SOCK" "$REMOTE" "$@"; }
remote_scp() { scp -o ControlPath="$SOCK" "$@"; }

# ─── steps ───────────────────────────────────────────────────────────────────

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --skip-tests)    SKIP_TESTS=1; shift ;;
      --dry-run)       DRY_RUN=1; shift ;;
      --add-token)     [ -n "${2:-}" ] || die "--add-token requires user:token"
                       ADD_TOKEN="$2"; shift 2 ;;
      --add-token=*)   ADD_TOKEN="${1#--add-token=}"; shift ;;
      --help|-h)
        sed -n '2,22p' "$0" | sed 's/^# \?//'
        exit 0
        ;;
      *) echo "unknown arg: $1"; exit 2 ;;
    esac
  done
}

run_tests() {
  if [ "$SKIP_TESTS" = "1" ]; then
    echo "(skipping ./test.sh — --skip-tests)"
    return 0
  fi
  step "Pre-flight: ./test.sh"
  ./test.sh
  ok "tests passed"
}

build_image() {
  step "Building $IMAGE"
  docker build -t "$IMAGE" . >/dev/null
  LOCAL_ID=$(docker images "$IMAGE" --format '{{.ID}}')
  ok "built $IMAGE ($LOCAL_ID)"
}

open_ssh() {
  SOCK="$HOME/.ssh/cm/deploy-$(echo "$REMOTE" | tr -c 'A-Za-z0-9' '_')"
  mkdir -p "$(dirname "$SOCK")"
  ssh -o ControlMaster=auto -o ControlPath="$SOCK" -o ControlPersist=10m \
      -o ConnectTimeout=10 -o ServerAliveInterval=30 -fN "$REMOTE" \
    || die "could not open SSH master to $REMOTE"
  trap 'ssh -o ControlPath="$SOCK" -O exit "$REMOTE" 2>/dev/null || true' EXIT
  remote "docker --version >/dev/null" || die "docker not available on $REMOTE"
}

ensure_state_dir() {
  step "Ensuring state dir on $REMOTE: $STATE_DIR"
  remote "mkdir -p '$STATE_DIR' '$STATE_DIR/home' '$STATE_DIR/wks'"
  ok "$STATE_DIR{,/home,/wks} ready"
}

# Ensure $STATE_DIR/.env contains MYCO_TOKENS with the default admin token.
# Idempotent: leaves any user-added tokens alone, only adds the default if
# missing. Mycod's docker-entrypoint.sh sources .env on startup, so the new
# container inherits the auth config without any further wiring.
ensure_default_token() {
  local result
  result=$(remote "
    EF='$STATE_DIR/.env'
    DT='$DEFAULT_TOKEN'
    if [ ! -f \"\$EF\" ]; then
      echo \"MYCO_TOKENS=\$DT\" > \"\$EF\"
      echo created
    elif grep -qF \"\$DT\" \"\$EF\"; then
      echo unchanged
    elif grep -qE '^MYCO_TOKENS=' \"\$EF\"; then
      sed -i \"s|^MYCO_TOKENS=\\(.*\\)\$|MYCO_TOKENS=\$DT,\\1|\" \"\$EF\"
      echo merged
    else
      echo \"MYCO_TOKENS=\$DT\" >> \"\$EF\"
      echo appended
    fi
  ")
  case "$result" in
    created)   ok ".env created with default admin token" ;;
    merged)    ok ".env: prepended default admin token to existing MYCO_TOKENS" ;;
    appended)  ok ".env: added MYCO_TOKENS with default admin token" ;;
    unchanged) ok ".env already has default admin token" ;;
    *)         die "ensure_default_token: unexpected result '$result'" ;;
  esac
}

# Read the first MYCO_TOKENS pair's token value from $STATE_DIR/.env on the
# remote. Used to authenticate /auth/reload after writing a new token (the
# new token isn't valid until reload finishes, so we authenticate with one
# that's already live).
read_existing_token() {
  remote "awk -F= '/^MYCO_TOKENS=/ {
    sub(/^MYCO_TOKENS=/, \"\");
    n = split(\$0, p, \",\");
    if (n>0) { split(p[1], kv, \":\"); print kv[2] }
  }' '$STATE_DIR/.env' 2>/dev/null"
}

# Idempotently upsert <user>:<token> into MYCO_TOKENS in $STATE_DIR/.env.
# Echoes one of: added | rotated | unchanged.
upsert_token_in_env() {
  local user="$1" token="$2"
  remote "USER='$user' TOK='$token' EF='$STATE_DIR/.env' bash -s" <<'REMOTE_SH'
    set -e
    if [ ! -f "$EF" ]; then
      echo "MYCO_TOKENS=$USER:$TOK" > "$EF"; echo added; exit 0
    fi
    if ! grep -q '^MYCO_TOKENS=' "$EF"; then
      echo "MYCO_TOKENS=$USER:$TOK" >> "$EF"; echo added; exit 0
    fi
    val=$(sed -n 's/^MYCO_TOKENS=//p' "$EF" | head -1)
    case ",$val," in *",$USER:$TOK,"*) echo unchanged; exit 0 ;; esac
    new=""; rotated=0
    IFS=','
    for pair in $val; do
      if [ "${pair%%:*}" = "$USER" ]; then
        new="${new:+$new,}$USER:$TOK"; rotated=1
      else
        new="${new:+$new,}$pair"
      fi
    done
    unset IFS
    if [ "$rotated" = "1" ]; then
      sed -i "s|^MYCO_TOKENS=.*|MYCO_TOKENS=$new|" "$EF"; echo rotated
    else
      sed -i "s|^MYCO_TOKENS=.*|MYCO_TOKENS=$val,$USER:$TOK|" "$EF"; echo added
    fi
REMOTE_SH
}

# POST /auth/reload over HTTPS using a token that was already live before the
# .env change. Dies on non-200.
hot_reload_auth() {
  local auth_tok="$1"
  local domain code
  domain=$(echo "$REMOTE" | sed 's/.*@//')
  code=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 10 -X POST \
           -H "Authorization: Bearer $auth_tok" \
           "https://$domain/auth/reload" || echo 000)
  [ "$code" = "200" ] || die "/auth/reload returned $code (token written to .env but server not reloaded)"
}

# Add or rotate a single user:token pair, then hot-reload the running server.
# Skips build/ship; this is for token-management only.
add_token() {
  local entry="$1"
  if ! [[ "$entry" =~ ^[A-Za-z0-9_-]{1,24}:[^,[:space:]]+$ ]]; then
    die "invalid --add-token '$entry' (expected user:token; user up to 24 chars [A-Za-z0-9_-], token non-empty, no commas/whitespace)"
  fi
  local user="${entry%%:*}"
  local token="${entry#*:}"

  step "Adding token for user '$user'"

  local existing_tok
  existing_tok=$(read_existing_token)
  [ -n "$existing_tok" ] || die "no existing token in $STATE_DIR/.env — cannot authenticate /auth/reload"

  local result
  result=$(upsert_token_in_env "$user" "$token")
  case "$result" in
    added)     ok ".env: added $user:<token>" ;;
    rotated)   ok ".env: rotated existing token for '$user'" ;;
    unchanged) ok ".env: $user:<token> already present (no reload needed)"; return 0 ;;
    *)         die "upsert_token_in_env: unexpected result '$result'" ;;
  esac

  hot_reload_auth "$existing_tok"
  ok "/auth/reload returned 200 — '$user' token is live"
}

seed_caddyfile() {
  if remote "test -f '$STATE_DIR/Caddyfile'"; then return 0; fi
  if remote "test -f /home/kkrazy/myco/Caddyfile"; then
    remote "cp /home/kkrazy/myco/Caddyfile '$STATE_DIR/Caddyfile'"
    ok "Caddyfile seeded from /home/kkrazy/myco/Caddyfile"
  else
    remote_scp Caddyfile "$REMOTE:$STATE_DIR/Caddyfile"
    ok "Caddyfile uploaded from project tree"
  fi
}

# Returns the named/anonymous-volume name docker assigned to a given mount
# destination on the running container, or empty if the mount is a bind or the
# container doesn't exist.
inspect_vol() {
  local dest="$1"
  remote "docker inspect $NAME --format '{{range .Mounts}}{{if eq .Destination \"$dest\"}}{{if eq .Type \"volume\"}}{{.Name}}{{end}}{{end}}{{end}}' 2>/dev/null" || true
}

# Copies a docker volume's contents into a host directory under STATE_DIR — but
# only if presence_check is FALSE (i.e. the host target hasn't been populated
# yet). Idempotent: re-runs are no-ops.
migrate_one() {
  local volname="$1" host_target="$2" presence_check="$3"
  [ -z "$volname" ] && return 0
  if remote "$presence_check"; then return 0; fi
  echo "  → migrating $volname → $host_target"
  remote "docker run --rm -v $volname:/src -v '$host_target':/dst alpine sh -c 'cp -an /src/. /dst/' >/dev/null"
}

migrate_volumes() {
  step "Migrating any existing volumes (one-time)"
  local data_vol root_vol wks_vol
  data_vol=$(inspect_vol /data)
  root_vol=$(inspect_vol /root)
  wks_vol=$(inspect_vol /wks)
  migrate_one "$data_vol" "$STATE_DIR"      "test -f '$STATE_DIR/sessions.json'"
  migrate_one "$root_vol" "$STATE_DIR/home" "test -e '$STATE_DIR/home/.claude.json' -o -d '$STATE_DIR/home/.claude'"
  migrate_one "$wks_vol"  "$STATE_DIR/wks"  "test -n \"\$(ls -A '$STATE_DIR/wks' 2>/dev/null)\""
  ok "migration done (no-op if state dir already populated)"
}

print_dry_run_plan() {
  step "DRY RUN — would now stream image and swap container"
  echo "  image:  $IMAGE ($LOCAL_ID)"
  echo "  remote: $REMOTE"
  echo "  state:  $STATE_DIR (and $STATE_DIR/{home,wks})"
  echo "  caddyf: $STATE_DIR/Caddyfile"
  echo "  cmd:    docker run -d --name $NAME --restart unless-stopped -p 80:80 -p 443:443 \\"
  echo "            -v $STATE_DIR:/data \\"
  echo "            -v $STATE_DIR/home:/root \\"
  echo "            -v $STATE_DIR/wks:/wks \\"
  echo "            -v $STATE_DIR/Caddyfile:/etc/caddy/Caddyfile:ro \\"
  echo "            $IMAGE"
  printf "\n✓ Dry-run complete. Re-run without --dry-run to deploy.\n"
}

stream_image() {
  step "Streaming $IMAGE to $REMOTE"
  docker save "$IMAGE" | gzip -1 | remote "gunzip | docker load" >/dev/null
  ok "image loaded"
}

swap_container() {
  step "Swapping container"
  remote "docker stop $NAME >/dev/null 2>&1 || true; \
          docker rm $NAME >/dev/null 2>&1 || true; \
          docker run -d --name $NAME --restart unless-stopped \
            -p 80:80 -p 443:443 \
            -v '$STATE_DIR:/data' \
            -v '$STATE_DIR/home:/root' \
            -v '$STATE_DIR/wks:/wks' \
            -v '$STATE_DIR/Caddyfile:/etc/caddy/Caddyfile:ro' \
            $IMAGE" >/dev/null
  ok "container started"
}

verify_deploy() {
  step "Verifying"
  local domain expected served
  domain=$(echo "$REMOTE" | sed 's/.*@//')
  expected=$(grep -oP 'app\.js\?v=\K\d+' web/public/index.html | head -1)
  served=""
  for i in 1 2 3 4 5 6 7 8; do
    served=$(curl -sk --max-time 5 "https://$domain/" 2>/dev/null | grep -oP 'app\.js\?v=\K\d+' | head -1)
    [ -n "$served" ] && break
    sleep 2
  done
  [ -n "$served" ] || die "https://$domain/ not responding after redeploy"
  [ "$served" = "$expected" ] \
    && ok "https://$domain/ serving app.js?v=$served (matches source)" \
    || die "version mismatch: served v$served, source v$expected"
}

# ─── main ────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"
  cd "$(dirname "$0")"

  if [ -n "$ADD_TOKEN" ]; then
    open_ssh
    add_token "$ADD_TOKEN"
    exit 0
  fi

  run_tests
  build_image
  open_ssh
  ensure_state_dir
  seed_caddyfile
  ensure_default_token
  migrate_volumes

  if [ "$DRY_RUN" = "1" ]; then
    print_dry_run_plan
    exit 0
  fi

  stream_image
  swap_container
  verify_deploy

  printf "\n✓ Deployed %s to %s (state: %s)\n" "$IMAGE" "$REMOTE" "$STATE_DIR"
}

main "$@"
