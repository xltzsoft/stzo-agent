#!/usr/bin/env bash
# Push the bridge server to the relay host and restart it.
#   deploy/deploy.sh [root@gc.stzo.cn]
set -euo pipefail
HOST="${1:-root@gc.stzo.cn}"
cd "$(dirname "$0")/.."
node --check server/server.mjs
rsync -rtv --delete --exclude .data --exclude .DS_Store server/ "$HOST:/opt/stzo-agent/server/"
rsync -tv deploy/stzo-agent-bridge.service "$HOST:/etc/systemd/system/stzo-agent-bridge.service"
ssh "$HOST" 'set -e
  id stzo-agent >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin stzo-agent
  chown -R root:root /opt/stzo-agent && chmod -R a+rX /opt/stzo-agent
  test -f /etc/stzo-agent/server.env || { echo "missing /etc/stzo-agent/server.env (see deploy/server.env.example)"; exit 1; }
  systemctl daemon-reload
  systemctl enable --now stzo-agent-bridge
  systemctl restart stzo-agent-bridge
  sleep 1
  curl -fsS http://127.0.0.1:3090/agent/api/health && echo'
