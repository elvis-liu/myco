#!/bin/sh
set -e

DATA="${MYCO_DATA:-/data}"
ENV_FILE="$DATA/.env"
CADDY_DATA="$DATA/caddy"

mkdir -p "$CADDY_DATA"

# Seed /root with shell config from stock /etc/skel if empty (first run)
if [ ! -f /root/.profile ]; then
    cp /etc/skel/.profile /root/ 2>/dev/null || true
fi

# Migrate data from old layout (pre-mount) if /root is missing claude config
if [ ! -f /root/.claude.json ] && [ -f "$DATA/.claude.json" ]; then
    cp "$DATA/.claude.json" /root/.claude.json
fi
if [ ! -d /root/.claude ] && [ -d "$DATA/.claude" ]; then
    cp -a "$DATA/.claude" /root/.claude
fi
if [ ! -d /root/.local ] && [ -d "$DATA/.local" ]; then
    cp -a "$DATA/.local" /root/.local
fi

export PATH="/root/.local/bin:$PATH"

# Load .env if it exists
if [ -f "$ENV_FILE" ]; then
    set -a
    . "$ENV_FILE"
    set +a
fi

export MYCO_WORKSPACE="/wks"
export MYCO_STATE_DIR="$DATA"
export XDG_DATA_HOME="$DATA"

# Start Caddy in background
caddy run --config /etc/caddy/Caddyfile &

# Start myco app
exec node server/src/index.js
