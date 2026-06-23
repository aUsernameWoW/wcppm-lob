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
      "allowFrom": ["wxid_xxx"],
      "groupAllowFrom": []
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

## Heartbeat conductor cutover

When migrating an account from the WCPPM server's hardcoded 60 s `AutoHeartBeat` loop to the **Mars-ported smart heartbeat conductor** (`src/heartbeat/`), follow these steps:

### 1. Disable the out-of-band AutoHeartBeat caller

The 60 s loop is started **outside** `wcppm-lob` (operator / admin backend / startup script). Ensure nothing will re-trigger `/api/Login/AutoHeartBeat` for this account:

- Locate the caller (likely in an operator dashboard, cron job, or manual provisioning script — **it is not `wcppm-lob`**).
- Disable or remove the call to `POST /api/Login/AutoHeartBeat?authcode=…`.

### 2. Restart the WCPPM server to clear the sticky loop

The 60 s heartbeat loop has **no runtime cancel endpoint**; the only way to stop it is to restart the `wechatpadpromax` binary:

```bash
# On the WCPPM server (100.64.0.8):
systemctl restart wechatpadpromax
```

After restart, the account no longer heartbeats every 60 s.

### 3. Bring up the account with the conductor

Deploy the middleware with `heartbeat.enabled=true` in `~/.config/wcppm/config.json`:

```json
{
  "heartbeat": {
    "enabled": true,
    "redisUrl": "redis://100.64.0.8:6379",
    "redisDb": 15,
    "activeWindowMs": 120000,
    "jitterPct": 0.07,
    "onlineCheckIntervalMs": 600000,
    "maxConsecutiveFailures": 4,
    "hardFloorMs": 60000,
    "maxPerHour": 30
  }
}
```

Then start the middleware:

```bash
systemctl --user restart wcppm-middleware
```

### 4. Verify the cadence has widened and is jittered

**Primary verification: inspect the OBSERVABLE heartbeat log** (proof of the real on-the-wire cadence):

```bash
# Query the heartbeat log in the WCPPM account's Redis db
# (the db holding that account's PERM:* keys — e.g. db0 or db1 — NOT db15):
redis-cli -h <wcppm-redis-host> -n <account_db> LRANGE heartbeatlog:<wxid> -6 -1

# Output: each entry is "[wxid_xxx] 心跳成功 <timestamp>"
# After cutover, consecutive timestamps should be ≥210 s apart and irregular (jittered) — 
# no longer exact 60 s intervals.
```

**Supplementary verification: check the conductor's internal learned state** (in db15, shows the intended interval):

```bash
# On the WCPPM Redis server or via the middleware box with redis-cli:
redis-cli -n 15
> GET hbconductor:<authcode>:<net_label>

# Look for: "curHeart" ≥ 210000 (milliseconds), jitter applied (not exact multiples of 60 s)
# Note: this is the algorithm's intended interval; the actual observed cadence is in heartbeatlog (above).
```

You can also tail the middleware logs to observe the conductor state transitions:

```bash
WCPPM_DEBUG=1 journalctl --user -u wcppm-middleware -f | grep -i heartbeat
```

Expected behaviour: intervals lengthen adaptively from 210 s, backoff on consecutive failures, and shorten again on success — never exact 60 s, with ±jitterPct (default 7%, per the config example above) random jitter applied on each cycle.
