#!/usr/bin/env bash
# Sets up (or updates) the production stack inside WSL as the normal user - no sudo needed:
#   1. installs a pinned Caddy release to ~/.local/bin, SHA-512 verified
#   2. publishes the frontend (deploy/publish.sh) if nothing is live yet
#   3. validates the Caddy config
#   4. installs and starts the systemd user services 3d-avatar-tts and 3d-avatar-web
# Windows, router and DNS steps: deploy/README.md. Safe to re-run.
set -euo pipefail

CADDY_VERSION="2.11.9"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$HOME/.local/bin"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/3d-avatar"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/3d-avatar"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NODE="$(command -v node)"
CADDY="$BIN/caddy"
mkdir -p "$BIN" "$DATA_DIR" "$STATE_DIR" "$UNIT_DIR"

# 1. Caddy (Apache-2.0): official GitHub release, checked against the release's checksum file.
if [[ "$("$CADDY" version 2>/dev/null | awk '{print $1}')" != "v$CADDY_VERSION" ]]; then
  case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;; esac
  tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
  url="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION"
  tarball="caddy_${CADDY_VERSION}_linux_${arch}.tar.gz"
  curl -fsSL -o "$tmp/$tarball" "$url/$tarball"
  curl -fsSL -o "$tmp/checksums.txt" "$url/caddy_${CADDY_VERSION}_checksums.txt"
  (cd "$tmp" && grep " $tarball\$" checksums.txt | sha512sum --check --strict -)
  tar -xzf "$tmp/$tarball" -C "$tmp" caddy
  install -m 0755 "$tmp/caddy" "$CADDY"
fi
echo "caddy: $("$CADDY" version)"

# 2. Frontend release
[[ -e "$DATA_DIR/current" ]] || "$ROOT/deploy/publish.sh"

# 3. Config check (same environment the service gets)
(cd "$ROOT/deploy/caddy" && SITE_ROOT="$DATA_DIR/current" LOG_DIR="$STATE_DIR" \
  "$CADDY" validate --config Caddyfile --adapter caddyfile 2>&1 | tail -n 1)

# 4. Services
for unit in 3d-avatar-tts.service 3d-avatar-web.service; do
  sed -e "s|@PROJECT_DIR@|$ROOT|g" -e "s|@NODE@|$NODE|g" -e "s|@CADDY@|$CADDY|g" \
      -e "s|@DATA_DIR@|$DATA_DIR|g" -e "s|@STATE_DIR@|$STATE_DIR|g" \
      "$ROOT/deploy/systemd/$unit" > "$UNIT_DIR/$unit"
done
systemctl --user daemon-reload

if ! systemctl --user is-active --quiet 3d-avatar-tts.service && ss -Hltn 'sport = :8882' | grep -q .; then
  echo "Port 8882 is held by a TTS server started by hand ('npm run tts'). Stop it, then re-run." >&2
  exit 1
fi
systemctl --user enable --now 3d-avatar-tts.service 3d-avatar-web.service
systemctl --user reload-or-restart 3d-avatar-web.service
systemctl --user --no-pager --lines=0 status 3d-avatar-tts.service 3d-avatar-web.service | grep -E '^\S|Active:'

if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo
  echo "NOTE: systemd lingering is off, so these services stop when your last session ends and"
  echo "      don't start at boot. deploy/windows/expose-3d-avatar.ps1 turns it on, or run:"
  echo "      sudo loginctl enable-linger $USER"
fi
