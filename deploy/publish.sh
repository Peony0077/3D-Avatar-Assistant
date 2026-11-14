#!/usr/bin/env bash
# Build the frontend into a fresh release directory and switch the live site to it atomically
# (Caddy serves ~/.local/share/3d-avatar/current, a symlink). The 3 newest releases are kept.
#
#   deploy/publish.sh             # typecheck + build + go live
#   deploy/publish.sh --rollback  # point the site back at the previous release
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${XDG_DATA_HOME:-$HOME/.local/share}/3d-avatar"
RELEASES="$BASE/releases"
KEEP=3
mkdir -p "$RELEASES"

activate() {
  ln -sfn "$1" "$BASE/current.new"
  mv -T "$BASE/current.new" "$BASE/current"   # rename() is atomic: no request sees a half state
  echo "live: $1"
}
current() { readlink -f "$BASE/current" 2>/dev/null || true; }

if [[ "${1:-}" == "--rollback" ]]; then
  cur="$(current)" prev=""
  while read -r d; do [[ "$d" == "$cur" ]] && break; prev="$d"; done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d | sort)
  [[ -n "$prev" ]] || { echo "No older release to roll back to." >&2; exit 1; }
  activate "$prev"
  exit 0
fi

cd "$ROOT"
rel="$RELEASES/$(date -u +%Y%m%dT%H%M%SZ)"
npx --no-install tsc --noEmit
npx --no-install vite build --outDir "$rel" --emptyOutDir --logLevel warn
[[ -f "$rel/index.html" ]] || { echo "Build produced no index.html" >&2; rm -rf -- "$rel"; exit 1; }
activate "$rel"

live="$(current)"
find "$RELEASES" -mindepth 1 -maxdepth 1 -type d | sort | head -n -"$KEEP" | while read -r d; do
  [[ "$d" == "$live" ]] || rm -rf -- "$d"
done
