#!/usr/bin/env bash
# Update THIS Conclave node to the latest pushed code and restart its supervised worker(s).
#
#   ./deploy/update.sh                  # fetch → if behind: pull + npm install + restart conclave-* services
#   CONCLAVE_DIR=~/conclave ./deploy/update.sh
#
# Exits 0 (no-op) when already current, so it's safe to run on a timer (see deploy/README.md).
set -euo pipefail

CONCLAVE_DIR=${CONCLAVE_DIR:-"$(cd "$(dirname "$0")/.." && pwd)"}
cd "$CONCLAVE_DIR"

BEFORE=$(git rev-parse --short HEAD 2>/dev/null || echo "?")
git fetch -q origin main
AFTER=$(git rev-parse --short origin/main 2>/dev/null || echo "?")
if [ "$BEFORE" = "$AFTER" ]; then
  echo "[update] already current ($AFTER)"
  exit 0
fi

echo "[update] $BEFORE -> $AFTER — pulling…"
git pull -q --ff-only origin main
npm install --no-audit --no-fund --silent

# Restart any supervised conclave worker(s) on this box so the new code is live.
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  UNITS=$(systemctl --user list-units --all --plain --no-legend 'conclave-*.service' 2>/dev/null | awk '{print $1}' | grep -v update || true)
  if [ -n "$UNITS" ]; then
    for u in $UNITS; do echo "[update] restarting $u"; systemctl --user restart "$u"; done
  else
    echo "[update] code updated — no conclave-* systemd service found; restart your conclave process manually."
  fi
else
  echo "[update] code updated — restart your conclave process to pick it up."
fi
echo "[update] ✅ now at $AFTER"
