# Deploying the standalone middleware + thin adapter

Architecture (see `docs/superpowers/specs/2026-06-06-wcppm-standalone-middleware-design.md`):

```
remote WCPPM (Tailscale 100.64.0.8) ──► [middleware: this box, systemd] ──WS/HTTP──► OpenClaw adapter
```

The **middleware** owns the WeChat connection (host/authcode/webhook, dedup, normalize, media, send) and exposes a downstream bridge (`WS /subscribe` + `POST /send` on `127.0.0.1:8077`). The **OpenClaw plugin** is now a thin client of that bridge.

## 1. Configure the middleware

```bash
mkdir -p ~/.config/wcppm
cp config.example.json ~/.config/wcppm/config.json
# edit: set host=100.64.0.8, real authcode, and a bridgeToken secret
```

Key fields: `host`/`port`/`authcode` (the WeChat server), `bridgeToken` (shared secret), `bridgePort` (default 8077). Full defaults in `src/core/config.ts`.

## 2. Build & live-verify P1 (do this BEFORE switching OpenClaw over)

```bash
cd ~/wcppm-lob && npm install && npm run build
node --disable-warning=ExperimentalWarning dist/core/main.js
# in another shell:
curl -s localhost:8077/healthz        # expect wsUp:true and selfWxid set
# send yourself a WeChat message — watch it arrive / log. Ctrl-C to stop.
```

If `wsUp` is false or no messages flow, it's a WeChat-server/login/webhook issue (debug per CLAUDE.md) — never `/Login/Newinit`.

## 3. Run the middleware as a service

```bash
cp deploy/wcppm-middleware.service ~/.config/systemd/user/   # edit node path if needed
systemctl --user daemon-reload
systemctl --user enable --now wcppm-middleware
journalctl --user -u wcppm-middleware -f
```

## 4. Point the OpenClaw adapter at the middleware

In `~/.openclaw/openclaw.json`, the `channels.wechatpadpro` block changes from the
old WeChat-server fields to the bridge fields:

```json
{
  "channels": {
    "wechatpadpro": {
      "bridgeUrl": "ws://127.0.0.1:8077",
      "bridgeToken": "<same secret as the middleware>",
      "account": "default",
      "dmSecurity": "allowlist",
      "allowFrom": ["wxid_xxx"]
    }
  }
}
```

Remove the old `host`/`authcode`/`webhook*`/`readOnly`/`maxMessageAge`/… keys from this block
(strict config validation 5.18+ rejects undeclared keys) — they now live in the middleware config.
Then deploy the plugin per the usual flow (pull → npm install → npm run build → `systemctl --user restart openclaw-gateway`).

## Notes / current limitations

- Outbound **media** is not yet supported over the bridge (middleware `/send` is text-only). Add a middleware `/sendMedia` endpoint to enable it.
- `openclaw gateway call wechatpadpro.forceSync` now proxies to the middleware's `POST /forceSync`.
