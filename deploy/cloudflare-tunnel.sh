#!/usr/bin/env bash
# Publishes the site through a Cloudflare Tunnel: cloudflared opens an outbound connection to
# Cloudflare, so no inbound port, router change or Windows setup is needed.
#
# Prerequisites: the domain is on Cloudflare, deploy/install.sh has run, and `cloudflared tunnel
# login` has been completed (it writes ~/.cloudflared/cert.pem). Then:
#   deploy/cloudflare-tunnel.sh
# Re-runnable: reuses the tunnel if it exists and re-points the DNS record at it.
set -euo pipefail

NAME="${TUNNEL_NAME:-3d-avatar}"
HOST="${TUNNEL_HOSTNAME:-3d-avatar.novaeuropa.space}"
ORIGIN="${TUNNEL_ORIGIN:-http://127.0.0.1:8081}"   # Caddy, deploy/caddy/Caddyfile
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CF="${CLOUDFLARED:-$HOME/.local/bin/cloudflared}"
DIR="$HOME/.cloudflared"
CONFIG="$DIR/$NAME.yml"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

[[ -x "$CF" ]] || { echo "cloudflared not found at $CF" >&2; exit 1; }
[[ -f "$DIR/cert.pem" ]] || { echo "Not logged in. Run: $CF tunnel login" >&2; exit 1; }

tunnel_id() {
  "$CF" tunnel list --output json --name "$NAME" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=(JSON.parse(s||"null")||[]).find(x=>!x.deleted_at||x.deleted_at.startsWith("0001-"));process.stdout.write(t?t.id:"")})'
}

id="$(tunnel_id)"
if [[ -z "$id" ]]; then
  "$CF" tunnel create "$NAME"
  id="$(tunnel_id)"
fi
[[ -n "$id" && -f "$DIR/$id.json" ]] || { echo "Tunnel '$NAME' has no credentials file in $DIR" >&2; exit 1; }
chmod 600 "$DIR/$id.json" "$DIR/cert.pem"
echo "tunnel: $NAME ($id)"

# DNS: a proxied CNAME  $HOST -> $id.cfargotunnel.com
"$CF" tunnel route dns --overwrite-dns "$NAME" "$HOST"

sed -e "s|@TUNNEL_ID@|$id|g" -e "s|@CREDENTIALS@|$DIR/$id.json|g" \
    -e "s|@HOSTNAME@|$HOST|g" -e "s|@ORIGIN@|$ORIGIN|g" \
    "$ROOT/deploy/cloudflare/tunnel.yml" > "$CONFIG"
"$CF" tunnel --config "$CONFIG" ingress validate

mkdir -p "$UNIT_DIR"
sed -e "s|@CLOUDFLARED@|$CF|g" -e "s|@CONFIG@|$CONFIG|g" -e "s|@HOSTNAME@|$HOST|g" \
    "$ROOT/deploy/systemd/3d-avatar-tunnel.service" > "$UNIT_DIR/3d-avatar-tunnel.service"
systemctl --user daemon-reload
systemctl --user enable 3d-avatar-tunnel.service
systemctl --user restart 3d-avatar-tunnel.service
systemctl --user --no-pager --lines=0 status 3d-avatar-tunnel.service | grep -E '^\S|Active:'
echo "Site: https://$HOST"
