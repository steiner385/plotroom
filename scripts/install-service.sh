#!/usr/bin/env bash
# Render deploy/pr-dashboard.service.template to the user systemd directory,
# substituting __APP_ROOT__ with this checkout's location, then daemon-reload.
# Usage: pnpm service:install   (then: systemctl --user enable --now pr-dashboard)
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$APP_ROOT/deploy/pr-dashboard.service.template"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/pr-dashboard.service"

[ -f "$TEMPLATE" ] || { echo "error: template not found: $TEMPLATE" >&2; exit 1; }

mkdir -p "$UNIT_DIR"
sed "s|__APP_ROOT__|$APP_ROOT|g" "$TEMPLATE" > "$UNIT"
systemctl --user daemon-reload
echo "Installed $UNIT (APP_ROOT=$APP_ROOT)"
