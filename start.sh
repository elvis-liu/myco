#!/usr/bin/env bash
set -a
. /home/kkrazy/myco/.env
set +a
cd /home/kkrazy/myco
exec /home/kkrazy/.local/node/bin/node server/src/index.js
