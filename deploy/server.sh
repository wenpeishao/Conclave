#!/usr/bin/env bash
# Deploy a Conclave coordination server in SECURE mode (per-agent identities + zones).
# One command: pulls the image, generates secrets if absent, runs the container, prints the
# join bundle the devices need.
#
#   ./deploy/server.sh                 # fresh secrets, default ports
#   CONCLAVE_TOKEN=… CONCLAVE_ADMIN_TOKEN=… ./deploy/server.sh    # reuse existing secrets
set -euo pipefail

IMAGE=${CONCLAVE_IMAGE:-wenpeishao/conclave:0.2}
DATA_VOL=${CONCLAVE_DATA_VOL:-conclave-data}
WS_PORT=${WS_PORT:-8787}
HTTP_PORT=${HTTP_PORT:-8088}
TOKEN=${CONCLAVE_TOKEN:-$(openssl rand -hex 24)}
ADMIN_TOKEN=${CONCLAVE_ADMIN_TOKEN:-$(openssl rand -hex 24)}

echo "[deploy] pulling $IMAGE …"
docker pull "$IMAGE" >/dev/null
docker rm -f conclave >/dev/null 2>&1 || true
docker run -d --name conclave --restart unless-stopped \
  -p "${WS_PORT}:8787" -p "${HTTP_PORT}:8088" \
  -e CONCLAVE_TOKEN="$TOKEN" \
  -e CONCLAVE_ADMIN_TOKEN="$ADMIN_TOKEN" \
  -v "${DATA_VOL}:/data" \
  "$IMAGE" >/dev/null

# Wait for health.
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${HTTP_PORT}/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done

HOST=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname)
WS="ws://${HOST}:${WS_PORT}"

cat <<EOF

✅ Conclave server up in SECURE mode.
   bus  : ${WS}
   http : http://${HOST}:${HTTP_PORT}    (health: /healthz)

   CONNECT TOKEN : ${TOKEN}
   ADMIN TOKEN   : ${ADMIN_TOKEN}     ← keep secret (invite/revoke/history)

   Open ports ${WS_PORT} (WS) and ${HTTP_PORT} (HTTP) to your devices, and put TLS
   (nginx → wss/https) in front before serving real traffic.

Onboard a device — invite it (admin), then run join.sh on the device:

   conclave invite --as coder --role coder --zone s-main \\
       --url ${WS} --token ${TOKEN} --admin-token ${ADMIN_TOKEN}

EOF
