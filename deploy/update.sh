#!/usr/bin/env bash
# Update THIS Conclave node to the latest pushed code and restart its supervised worker(s).
#
#   ./deploy/update.sh                  # fetch → if behind: pull + npm install + restart conclave-* services
#   CONCLAVE_DIR=~/conclave ./deploy/update.sh
#
# Exits 0 (no-op) when already current, so it's safe to run on a timer (see deploy/README.md).
set -euo pipefail

CONCLAVE_DIR=${CONCLAVE_DIR:-"$(cd "$(dirname "$0")/.." && pwd)"}
BRANCH=${CONCLAVE_BRANCH:-main}
cd "$CONCLAVE_DIR"

# Guard the timer against crash-looping: a dirty tree or a local commit ahead of origin makes
# `git pull --ff-only` fail under `set -e`. Skip gracefully (exit 0) instead.
if [ -n "$(git status --porcelain)" ]; then
  echo "[update] local changes present — skipping (commit/stash to re-enable auto-update)"
  exit 0
fi
git fetch -q origin "$BRANCH"
BEFORE=$(git rev-parse --short HEAD)
AFTER=$(git rev-parse --short "origin/$BRANCH")
if [ "$BEFORE" = "$AFTER" ]; then
  echo "[update] already current ($AFTER)"
  exit 0
fi
if ! git merge-base --is-ancestor HEAD "origin/$BRANCH"; then
  echo "[update] local HEAD ($BEFORE) is ahead of / diverged from origin/$BRANCH — skipping"
  exit 0
fi

echo "[update] $BEFORE -> $AFTER — pulling…"
git pull -q --ff-only origin "$BRANCH"
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
