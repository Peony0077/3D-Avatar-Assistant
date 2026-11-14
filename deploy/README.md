# Deploying to https://3d-avatar.novaeuropa.space

Self-hosted on this Windows PC's WSL2 and published through a **Cloudflare Tunnel**. `cloudflared` opens
an outbound connection to Cloudflare, so no inbound port, router change or Windows setup is needed, and it
also works behind CGNAT. Cloudflare terminates HTTPS. Caddy (open source) serves the built frontend and
proxies the TTS server on loopback only.

```
browser ──HTTPS──▶ Cloudflare (DNS: proxied CNAME 3d-avatar → <tunnel id>.cfargotunnel.com)
                       │ tunnel, opened outbound from WSL
                       ▼
WSL2   cloudflared (3d-avatar-tunnel) ──▶ Caddy http://127.0.0.1:8081 (3d-avatar-web, deploy/caddy/Caddyfile)
                                            ├─ /                         → ~/.local/share/3d-avatar/current (built frontend)
                                            ├─ POST /tts/v1/synthesize   → 127.0.0.1:8882 (HeadTTS, 3d-avatar-tts)
                                            └─ POST /llm/v1/chat/completions → 127.0.0.1:11434 (optional Ollama)
```

## One-time setup

1. **WSL:** stop any hand-started `npm run tts`, then run `deploy/install.sh`. It installs Caddy (pinned
   version, SHA-512 verified) to `~/.local/bin`, publishes the frontend, and starts the user services
   `3d-avatar-tts` and `3d-avatar-web`.
2. **cloudflared:** download the `cloudflared-linux-amd64` release binary from
   [github.com/cloudflare/cloudflared](https://github.com/cloudflare/cloudflared/releases) to
   `~/.local/bin/cloudflared` and make it executable.
3. **Log in** (the domain must be on Cloudflare): run `~/.local/bin/cloudflared tunnel login`, open the
   printed link and authorize `novaeuropa.space`. This writes `~/.cloudflared/cert.pem`. The link only
   works while that command is still running (about 10 minutes).
4. **Create the tunnel:** run `deploy/cloudflare-tunnel.sh`. It creates (or reuses) the tunnel `3d-avatar`,
   points the DNS record at it (`--overwrite-dns` replaces an existing A record for the host), writes
   `~/.cloudflared/3d-avatar.yml` from `deploy/cloudflare/tunnel.yml`, and enables the user service
   `3d-avatar-tunnel`. It is safe to run again.

`~/.cloudflared/` holds the account certificate and the tunnel credentials. Keep it private and never
commit it.

## Day to day

| Task | Command (in WSL) |
|---|---|
| Ship frontend changes | `deploy/publish.sh` (typecheck, build into a new release, switch atomically) |
| Undo the last release | `deploy/publish.sh --rollback` |
| Apply Caddyfile changes | `systemctl --user reload 3d-avatar-web` |
| Status | `systemctl --user status 3d-avatar-web 3d-avatar-tts 3d-avatar-tunnel` |
| Server logs | `journalctl --user -u 3d-avatar-web -u 3d-avatar-tts -u 3d-avatar-tunnel -f` |
| Access log | `~/.local/state/3d-avatar/access.log` |
| Smoke test the live site | `node tools/smoke-test.mjs https://3d-avatar.novaeuropa.space` |

Local development is unchanged. `npm run dev` uses the same TTS service on 127.0.0.1:8882.

## Troubleshooting

- **Cloudflare error 1033 or 530:** the tunnel is down. Check `systemctl --user status 3d-avatar-tunnel`.
  The site is only up while WSL (and so this PC) is running.
- **Cloudflare error 502:** the tunnel is up but Caddy isn't. Check `systemctl --user status 3d-avatar-web`
  and `curl -I http://127.0.0.1:8081/`.
- **Old page after publishing:** hashed assets are cached forever and `index.html` is not cached, so a normal
  reload is enough. If Cloudflare caching rules were added, purge the cache in the dashboard.
- **Console error about `cloudflareinsights.com` beacon:** Cloudflare Web Analytics injects a script that the
  site's Content-Security-Policy blocks. It is harmless. Turn off Web Analytics for the zone to silence it.

## Security notes

- Nothing listens publicly: Caddy binds 127.0.0.1:8081, TTS listens on loopback (`TTS_HOST`, default
  `127.0.0.1`), and the Vite dev server on 5173 is not exposed.
- Only two backend endpoints are public (`/tts/v1/synthesize`, `/llm/v1/chat/completions`), with request
  size limits. Ollama's model management API is never exposed.
- Responses carry HSTS, a strict Content-Security-Policy (checked with `tools/smoke-test.mjs`), and
  `Permissions-Policy` that allows the microphone for this site only. Caddy logs the visitor's real IP
  from Cloudflare's `Cf-Connecting-Ip` header.
- The TTS endpoint has no rate limiting, so anyone who can open the site can use its CPU. If that becomes a
  problem, add a Cloudflare rate-limiting rule or put the site behind Cloudflare Access.

## Alternative: direct hosting without Cloudflare

`deploy/caddy/Caddyfile.direct` serves the site with Caddy's own Let's Encrypt certificate on ports
forwarded from the router. Inside WSL, Caddy listens on 8080/8443, because an unprivileged user can't bind
ports below 1024. It is told the public ports are 80/443, so certificates and redirects work normally.

1. Stop the tunnel (`systemctl --user disable --now 3d-avatar-tunnel`), then run
   `cp deploy/caddy/Caddyfile.direct deploy/caddy/Caddyfile` and
   `systemctl --user restart 3d-avatar-web`.
2. **DNS:** replace the tunnel CNAME with an `A` record: host `3d-avatar`, value `<your public IP>`, TTL 300,
   DNS only (not proxied).
3. **Windows**, in PowerShell run as Administrator:
   ```powershell
   powershell -ExecutionPolicy Bypass -File "\\wsl.localhost\<Distro>\home\peony\projects\3D-Avatar-Assistant\deploy\windows\expose-3d-avatar.ps1"
   ```
   (`wsl -l -v` shows the distro name.) It enables lingering so services start with WSL, opens the firewall
   for TCP 80/443, forwards them into WSL, and adds the boot task `3D Avatar - WSL`, which keeps WSL running
   and updates the forwarding after every restart. When asked, enter your Windows password so the task can
   run before anyone signs in. Use `-Remove` to undo. The Windows-side log is
   `C:\ProgramData\3d-avatar\wsl-forward.log`.
4. **Router:** forward TCP 80 and 443 to the Windows PC's LAN IP (the script prints it). Give the PC a DHCP
   reservation so that IP doesn't change.

Direct-hosting pitfalls:
- **Certificate never issues:** both ports must reach Caddy from the internet.
- **Works from outside but not at home:** the router lacks hairpin NAT.
- **Nothing reaches the router:** the ISP uses CGNAT or blocks inbound 80/443. These are the usual reasons to
  use the tunnel instead.
- **Dynamic public IP:** update the A record when it changes.
