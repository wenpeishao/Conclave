#!/usr/bin/env bash
# Onboard THIS device as a Conclave node: enroll a local identity, then run a worker under a
# supervised service (systemd on Linux, nohup fallback elsewhere) so it survives reboots/crashes.
#
# Get an enrollment token from the admin (conclave invite --as <name> …), then:
#   ENROLL=<token> ./deploy/join.sh --as <name> --url ws://host:8787 --token <connect> \
#       --role <role> [--zone <zone>] [--permission bypassPermissions]
#
# Assumes the conclave repo is available (CONCLAVE_DIR, default ~/conclave) with `npm install`
# done, and node >= 22 + (for claude workers) the `claude` CLI logged in on PATH.
set -euo pipefail

CONCLAVE_DIR=${CONCLAVE_DIR:-"$HOME/conclave"}
ENROLL=${ENROLL:?set ENROLL=<enrollment-token> (from: conclave invite …)}
NAME="" URL="" TOKEN="" ROLE="" ZONE="" PERM=""
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --as) NAME="$2"; shift 2;;
    --url) URL="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --role) ROLE="$2"; shift 2;;
    --zone) ZONE="$2"; shift 2;;
    --permission) PERM="$2"; shift 2;;
    *) args+=("$1"); shift;;
  esac
done
: "${NAME:?--as <name> required}" "${URL:?--url required}" "${TOKEN:?--token required}"

cd "$CONCLAVE_DIR"
[ -d node_modules ] || npm install --no-audit --no-fund

echo "[join] enrolling identity for agent://${NAME} …"
node --import tsx src/cli.ts join --as "$NAME" --enroll "$ENROLL" --url "$URL" --token "$TOKEN"

# Build the worker command.
WORK=(node --import tsx "$CONCLAVE_DIR/src/cli.ts" work --as "$NAME" --url "$URL" --token "$TOKEN")
[ -n "$ROLE" ] && WORK+=(--role "$ROLE")
[ -n "$ZONE" ] && WORK+=(--zone "$ZONE")
[ -n "$PERM" ] && WORK+=(--permission "$PERM")

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  UNIT="conclave-${NAME}"
  echo "[join] installing systemd --user service ${UNIT} …"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/${UNIT}.service" <<EOF
[Unit]
Description=Conclave node ${NAME}
After=network-online.target

[Service]
Environment=PATH=${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=${CONCLAVE_DIR}
ExecStart=${WORK[*]}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "${UNIT}.service"
  loginctl enable-linger "$USER" >/dev/null 2>&1 || true
  echo "[join] ✅ running as systemd --user service ${UNIT} (survives reboot). Logs: journalctl --user -u ${UNIT} -f"
else
  # No systemd → nothing would relaunch the node when self-update exits on purpose, and the first
  # successful update would silently take it down for good. --supervise is the built-in stand-in
  # (systemd's Restart=always covers it above, which is why it is NOT passed there).
  echo "[join] no systemd — starting under nohup + --supervise (restarts on exit; add an @reboot cron for boot)."
  nohup "${WORK[@]}" --supervise >"$HOME/.conclave-${NAME}.log" 2>&1 &
  echo "[join] ✅ running supervised (pid $!). Logs: ~/.conclave-${NAME}.log"
  echo "[join] ⚠ won't survive reboot — see docs/join-a-claude.md for the @reboot crontab line."
fi
