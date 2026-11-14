# Deploying to https://3d-avatar.novaeuropa.space

Self-hosted on this Windows PC's WSL2, with no third-party tunnel or CDN. Caddy (open source) serves the
built frontend, proxies the TTS server, and gets and renews the Let's Encrypt certificate itself.

```
browser ── DNS A 3d-avatar → <public IP>
   │
router  :80, :443 ──port forward──▶ Windows PC :80, :443
   │                                   │ netsh portproxy (kept current by a boot task)
   ▼                                   ▼
WSL2 (NAT, 172.x)   Caddy :8080 (HTTP→HTTPS, ACME)   Caddy :8443 (site)
                       ├─ /                         → ~/.local/share/3d-avatar/current (built frontend)
                       ├─ POST /tts/v1/synthesize   → 127.0.0.1:8882 (HeadTTS, loopback only)
                       └─ POST /llm/v1/chat/completions → 127.0.0.1:11434 (optional Ollama)
```

Ports 8080/8443 are used inside WSL because an unprivileged user can't bind ports below 1024. Caddy is told
the public ports are 80/443, so certificates and redirects work normally.

## One-time setup

1. **WSL:** stop any hand-started `npm run tts`, then run `deploy/install.sh`. It installs Caddy (pinned
   version, SHA-512 verified) to `~/.local/bin`, publishes the frontend, and starts the user services
   `3d-avatar-tts` and `3d-avatar-web`.
2. **DNS** for `novaeuropa.space`: add an `A` record with host `3d-avatar`, value `<your public IP>`, TTL 300.
3. **Windows**, in PowerShell run as Administrator:
   ```powershell
   powershell -ExecutionPolicy Bypass -File "\\wsl.localhost\<Distro>\home\peony\projects\3D-Avatar-Assistant\deploy\windows\expose-3d-avatar.ps1"
   ```
   (`wsl -l -v` shows the distro name.) It enables lingering so services start with WSL, opens the firewall
   for TCP 80/443, forwards them into WSL, and adds the boot task `3D Avatar - WSL`, which keeps WSL running
   and updates the forwarding after every restart. When asked, enter your Windows password so the task can
   run before anyone signs in. Use `-Remove` to undo.
4. **Router:** forward TCP 80 and 443 to the Windows PC's LAN IP (the script prints it). Give the PC a DHCP
   reservation so that IP doesn't change.
5. Once DNS resolves (`nslookup 3d-avatar.novaeuropa.space`), run `systemctl --user restart 3d-avatar-web`
   so Caddy tries for the certificate straight away instead of waiting for its retry backoff.

## Day to day

| Task | Command (in WSL) |
|---|---|
| Ship frontend changes | `deploy/publish.sh` (typecheck, build into a new release, switch atomically) |
| Undo the last release | `deploy/publish.sh --rollback` |
| Apply Caddyfile changes | `systemctl --user reload 3d-avatar-web` |
| Status | `systemctl --user status 3d-avatar-web 3d-avatar-tts` |
| Server logs | `journalctl --user -u 3d-avatar-web -u 3d-avatar-tts -f` |
| Access log | `~/.local/state/3d-avatar/access.log` |
| Windows-side log | `C:\ProgramData\3d-avatar\wsl-forward.log` |

Local development is unchanged. `npm run dev` uses the same TTS service on 127.0.0.1:8882.

## Troubleshooting

- **Certificate never issues:** both ports must reach Caddy from the internet. Test from a phone on mobile
  data: `http://3d-avatar.novaeuropa.space` should redirect to HTTPS. Check `journalctl --user -u 3d-avatar-web`.
- **Works from outside but not at home:** many routers don't support hairpin NAT. Test from a phone on mobile
  data, or point `3d-avatar.novaeuropa.space` at the PC's LAN IP in your router's local DNS (or a device's
  hosts file).
- **Nothing reaches the router:** if the router's WAN IP differs from the public IP above, the ISP uses CGNAT, and
  you need a public IP from them. Some ISPs also block inbound 80/443 on home plans.
- **Public IP changed:** home IPs can be dynamic. Update the A record, or use your DNS provider's dynamic-DNS
  updater.
- **Access log shows one client IP for everyone:** expected. Windows port forwarding is a TCP relay, so Caddy
  sees the Windows host's address.

## Security notes

- Only two backend endpoints are public (`/tts/v1/synthesize`, `/llm/v1/chat/completions`), with request
  size limits. Ollama's model management API is never exposed.
- TTS listens on loopback only (`TTS_HOST`, default `127.0.0.1`). The Vite dev server on 5173 is not forwarded.
- Responses carry HSTS, a strict Content-Security-Policy (checked with `tools/smoke-test.mjs`), and
  `Permissions-Policy` that allows the microphone for this site only.
- The TTS endpoint has no rate limiting, so anyone who can open the site can use its CPU. If that becomes a
  problem, add the `caddy-ratelimit` plugin or put the site behind `basic_auth`.
