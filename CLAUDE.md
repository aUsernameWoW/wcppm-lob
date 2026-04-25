# CLAUDE.md — LLM Guide for wcppm-lob

## What This Is

An OpenClaw channel plugin that bridges WeChatPadPro / WeChatPadProMAX into OpenClaw, enabling WeChat message send/receive through the OpenClaw framework.

## Scope & Responsibilities

**This plugin does NOT handle (firm boundary, do not expand):**
- **All `/Login/*` operations** — QR code scanning, 62-data login, A16 login, token renewal, heartbeat management, **and `/Login/Newinit`**
- **All `/User/*` operations** — account info edits, profile, device management, etc.

These are the WeChatPadProMax server administrator's responsibility, configured out-of-band (Swagger UI / curl). If no messages arrive because the operator forgot to run `/Login/Newinit` or `/Webhook/Set`, **that's an operator config issue, not ours** — we don't paper over it by re-introducing auto-calls into those surfaces.

**Hard constraints confirmed in production:**
- For account nurturing / safety, prefer passive receive paths and avoid unnecessary active operations

**Newinit history (was auto-called, now reverted):**
- WCPP MAX 0412+ requires `/Login/Newinit` to establish the longlink before any push channel (WS / Webhook / RabbitMQ) actually receives data
- We briefly auto-called Newinit on startup, but this re-enters `/Login/*` scope. **Reverted**: the operator runs Newinit manually. The `newinitOnStart` config flag was removed in the transport refactor

**This plugin assumes:**
- The WeChatPadProMax server is already logged in and online
- `/Login/Newinit` has been called (by the operator) so the server's longlink is up
- A valid `authcode` (for MAX) or `adminKey` + `authKey` (for standard WCPP) is provided by the server admin **if** any active operation is needed (sending, contact fetch, auto-register webhook). Pure passive webhook receive needs neither.
- The WeChat account is stable and ready to send/receive messages

**This plugin focuses on:**
- Message synchronization (receiving via WebSocket, HTTP Sync polling, or Webhook push)
- Message sending (text, image, voice, etc.)
- Contact/group metadata caching
- OpenClaw channel protocol compliance

## Architecture

```
src/
├── index.ts          — Plugin entry point (defineChannelPluginEntry)
├── channel.ts        — OpenClaw channel plugin definition + runtime lifecycle
│                       (config adapter, gateway.startAccount/stopAccount, outbound)
├── client.ts         — Core API client: auth, WebSocket, Sync polling, Webhook receive, send
├── dispatch.ts       — Inbound → OpenClaw auto-reply pipeline bridge
│                       (resolveAgentRoute → finalizeInboundContext →
│                        createReplyDispatcherWithTyping → dispatchInboundMessage)
├── setup-entry.ts    — Lightweight setup entry for onboarding
└── shims/
    └── openclaw/     — Typecheck-only shims for openclaw/plugin-sdk/* paths
        ├── channel-core.ts
        ├── channel-pairing.ts
        ├── channel-reply-pipeline.ts
        ├── config-runtime.ts
        ├── direct-dm-access.ts
        ├── reply-runtime.ts
        └── routing.ts
tools/
└── debug.ts          — Standalone CLI for testing WCPP MAX API (npx tsx tools/debug.ts)
docs/
└── api-reference/    — Full offline mirror of WeChatPadProMAX API docs
    ├── INDEX.md      — Master index: category → local file mapping
    ├── llms.txt      — Original index from wx.knowhub.cloud
    ├── docs/         — 6 guide docs (quickstart, webhook spec, etc.)
    ├── api/          — 211 endpoint docs (Msg, Friend, Group, Tools, etc.)
    └── schemas/      — 173 request/response schema docs
```

## Manifest (`openclaw.plugin.json`)

The OpenClaw gateway web UI renders channel settings from `channelConfigs[channelId].schema` + `channelConfigs[channelId].uiHints`, **not** from the top-level `configSchema` (which is plugin-scope, not channel-scope). Put all wechatpadpro fields under `channelConfigs.wechatpadpro.schema`; leave top-level `configSchema` as an empty `{ "type": "object", "properties": {} }`.

- `uiHints` keys must match schema property names; supported hint fields are `label`, `help`, `placeholder`, `sensitive`, `advanced`, `tags`, `itemTemplate` (defined in `openclaw/plugin-sdk` → `channels/plugins/types.config.ts`)
- OpenClaw does **not** recognize custom `x-openclaw-*` JSON Schema keys — don't put `x-openclaw-order`, `x-openclaw-showWhen`, etc., they're silently ignored
- Reference: `src/config/channel-config-metadata.ts:69-82` in the OpenClaw source (at `/home/radxa/openclaw-source-codes`)

## Plugin Surface Required by the OpenClaw Gateway

A channel plugin is just `{ id, meta, capabilities, configSchema, config, setup, gateway, security?, threading?, outbound? }`. **Anything missing here will silently break a different gateway code path** — there is no central validator, the gateway just calls `plugin.config.X(...)` and crashes.

- `config` — **required**. Implements `listAccountIds`, `resolveAccount`, `defaultAccountId`, `inspectAccount`, `isEnabled`, `isConfigured`, `describeAccount`, `setAccountEnabled`, `deleteAccount`, `resolveAllowFrom`, `formatAllowFrom`. Without these the web UI errors out with `TypeError: Cannot read properties of undefined (reading 'listAccountIds')` on every `channels.status` / `health` / `usage.cost` call. `resolveAccount` must NOT throw on partial config — the gateway introspects the channel before the user finishes the form.
- `gateway.startAccount(ctx)` / `stopAccount(ctx)` — without these the channel renders in the UI but never actually connects. `ctx` provides `{ cfg, accountId, account, runtime, abortSignal, log, getStatus, setStatus }`. **`startAccount` is treated as a long-running task**: the moment its returned promise resolves, the gateway flips `running: false` in its `finally` (`server-channels.ts:418-444`). It must `await` something that only resolves on `ctx.abortSignal` aborting — see how we wrap the abort signal at the bottom of `startAccount` in `src/channel.ts`.
- `setup` — only `resolveAccountId` and `applyAccountConfig` are read by the gateway. `inspectAccount`/`resolveAccount` belong on `config`, not `setup` (the gateway never calls `plugin.setup.inspectAccount`).
- Reference plugin layout: `extensions/twitch/src/plugin.ts` and `extensions/feishu/src/channel.ts` in the OpenClaw source.

### Two silent-drop traps that have already burned us — check first when a channel won't start

When the channel loads, web UI shows `已配置=是 运行中=否` (or CLI shows `disabled, configured` with **no** `error:` field, no `channel exited`, no `channel startup failed`, and zero plugin-internal logs after `gateway ready`), it is almost certainly one of these:

1. **`createChannelPluginBase` silently drops `gateway`.** That helper (`src/plugin-sdk/core.ts:638` in the OpenClaw source) only spreads `id, meta, setup, capabilities, commands, doctor, agentPrompt, streaming, reload, gatewayMethods, configSchema, config, security, groups`. **`gateway` is not in the list.** Putting `gateway: { startAccount, stopAccount }` inside `createChannelPluginBase({...})` makes `plugin.gateway === undefined`, and the gateway short-circuits at `server-channels.ts:292` (`if (!startAccount) return;`) without logging anything. **Fix**: structure like `extensions/twitch/src/plugin.ts` — build a plain base object that includes `gateway` as a sibling of `id/meta/setup/config`, then pass it as `base:` to `createChatChannelPlugin`. See `src/channel.ts:wechatpadproBase`.
2. **`isEnabled` must not call `isConfigured(account)`.** The gateway probes `plugin.config.isEnabled(account, cfg)` with a stub account where `account.host` and `account.webhookEnabled` are both undefined. If `isEnabled` delegates to `isConfigured(account)`, that stub call returns false → gateway records `enabled: false, lastError: "disabled"` → channel never starts. `isEnabled` must look at `section.enabled !== false` only; configuration completeness is `isConfigured`'s separate concern.

Diagnosis order: (1) run `openclaw channels status` — if no `running`, the lifecycle is broken (these traps) not the plugin's internal logic. (2) Add `console.error("[trace] startAccount entered")` at the top of `startAccount`. If it never fires, you're hitting trap 1 or one of the silent-return guards in `server-channels.ts:285-396`. (3) Add `console.error` inside `isEnabled` and `isConfigured` to spot stub-account calls.

## Inbound Auto-Reply Pipeline

`gateway.startAccount` calls `startWcppRuntime`, which produces `NormalizedMessage` objects. Each message is forwarded to `dispatchInboundToOpenClaw` (in `src/dispatch.ts`) which runs:

```
loadConfig → resolveAgentRoute → finalizeInboundContext →
  createChannelReplyPipeline → createReplyDispatcherWithTyping →
  dispatchInboundMessage
```

The `deliver` callback we hand to the dispatcher is what closes the loop — it receives the agent's `ReplyPayload` and calls `client.sendText` (or `sendQuote` when `payload.replyToId` / `payload.replyToTag` is set). Errors in the deliver path are logged with the `wechatpadpro:` prefix, never thrown — one bad message must not kill the receiver loop.

**MsgContext fields** (built in `dispatch.ts:buildFromTag` and the `finalizeInboundContext` call): `Provider`, `Surface`, `OriginatingChannel` all = `"wechatpadpro"`; `ChatType` = `"group"|"direct"`; `From` = `group:${groupId}` for groups, `wechatpadpro:${senderWxid}` for DMs; `To` = the wxid we send the reply back to (groupId for groups, senderWxid for DMs); `SessionKey`/`AccountId` from `resolveAgentRoute`; `WasMentioned` only set for groups.

### DM policy gate (`dmSecurity`)

DMs are gated **inside our plugin** before the agent pipeline runs — the framework's `reply-runtime` / `channel-reply-pipeline` / `routing.ts` do **not** enforce `dmPolicy`, so declaring `security.dm` on the plugin alone is metadata-only. The gate is built in `channel.ts:buildDmAuthorizer` and invoked at the top of `dispatch.ts:dispatchInboundToOpenClaw`. Groups bypass the gate entirely.

Flow, per DM:
1. `buildDmAuthorizer` wires `createChannelPairingController` + `createPreCryptoDirectDmAuthorizer` against `ctx.runtime` at startup.
2. For each inbound DM, `authorizeDm({ senderId, reply })` runs before `resolveAgentRoute`. `reply` is `client.sendText(senderWxid, ...)`.
3. Decision table (from `src/security/dm-policy-shared.ts:resolveDmGroupAccessDecision`):
   - `"open"` → allow
   - `"disabled"` → block
   - `"allowlist"` → allow if sender in `allowFrom`, else block
   - `"pairing"` (default when `dmSecurity` is unset) → allow if in `allowFrom` or pairing store, else emit **one** pairing challenge via `sendText` (subsequent unpaired messages are silent until paired)
4. On anything but `"allow"`, dispatch returns without touching the agent.

Matching is exact-string on wxid, with `"*"` wildcard. `runtime.channel.commands.*` is consulted only for command authorization and falls back to `() => false` stubs when absent, so a missing command surface doesn't break DM gating.

**When `ctx.runtime` is undefined** (older gateway, tests), `authorizeDm` stays `undefined` and the dispatcher falls through to "allow everything" — we'd rather lose the policy than silently swallow DMs the user expects to see.

**Out of scope today** (would need additional work):
- Inbound media routed to the agent — currently text-only; resolved media is on `msg.raw.media` if needed
- `ReplyPayload.mediaUrl` / `interactive` / `btw` — `deliver` ignores everything except `text`. Explicit `outbound.sendMedia` calls still work.
- Typing indicators, debouncer, history aggregation, mention regex preprocessing — all skipped
- Group `groupPolicy` / `groupAllowFrom` enforcement — only DM side is gated; groups pass unconditionally

## API Reference

Full WeChatPadProMAX API documentation is mirrored locally in `docs/api-reference/`.
- **Start with** `docs/api-reference/INDEX.md` to find any endpoint by category
- Files are named by their upstream ID (e.g. `356821064e0.md` for SendTxt)
- Covers all modules: Admin, Login, Msg, Friend, Group, FriendCircle, Finder, Tools, Webhook, User, TenPay, Wxapp, OfficialAccounts, Label, etc.
- Sourced from `https://wx.knowhub.cloud/llms.txt` (Apifox-hosted, can be flaky)

## Transport Model

The plugin supports WCPPM only. The legacy standard-WeChatPadPro path (`/ws/GetSyncMsg` + `adminKey` + QR login) was dropped in the sync-mode refactor; the former `syncMode` enum is gone.

### Base: WebSocket push (WCPPM `/ws/sync`)
- Always active when `host` is set.
- `ws://{host}:8089/ws/sync?authcode=AUTHCODE` (override with `wsUrl`).
- Real-time push wrapped in the 20260411+ outer envelope — two shapes (`Data.syncData` / `Data.data`) carry the same inner SyncResponse, so every message is delivered twice; dedup by `MsgId` handles this.
- `Data.wxid` on the envelope supplies self-wxid without needing ModUserInfos.
- Auto-reconnects on close. No fallback-to-polling path — the WS was unstable on 0412 but is solid on 0416+; if it ever breaks again, surface the error instead of silently switching transports.
- This is also the only outbound path: sends always use `/api/Msg/SendTxt` / `/api/Msg/Quote` / etc. via HTTP.

### Additive: webhook receiver (`webhookEnabled: true`)
- Opt-in extra inbound channel on top of WebSocket. Spins up a local HTTP listener; WCPPM pushes to it via the standard `/Webhook/*` flow.
- When `host` is set and `webhookUrl` is configured, the plugin auto-calls `/Webhook/Set` on start and `/Webhook/Remove` on stop. If `webhookUrl` is omitted, the plugin still binds the listener but leaves registration to the operator.
- **Passive webhook-only mode**: set `webhookEnabled: true` with `host` empty. Plugin only binds the listener; `/Login/Newinit` + `/Webhook/Set` are the operator's job, and outbound sends will throw because there's no server to talk to. This is the layout for fully decoupled deployments (unstable WCPPM address, strict separation from `/Login/*`).
- Default bind is loopback (`127.0.0.1`) to force a reverse proxy as the public entry; set `webhookHost: "0.0.0.0"` to expose directly.
- Webhook payload envelope: `{ MessageType, Signature, Timestamp, Wxid, IsSelf, Data: { messages: [...] } }`; signature = `HMAC-SHA256(secret, "{Wxid}:{MessageType}:{Timestamp}")` with a 15-minute anti-replay window.
- Messages are converted to the internal `SyncMessage` shape and routed through the same dedup + filter + normalize pipeline as WS. When both WS and webhook deliver the same message, dedup by `MsgId` drops the duplicate.
- Limitation: webhook payload has no `MsgSource`, so `<atuserlist>` @bot detection falls back to `pushContent` ("在群聊中@了你") only.

### One-shot: `forceSync()` (manual catch-up)
- `WcppClient.forceSync()` performs a single `/api/Msg/Sync` pull and drains `ContinueFlag` before returning. No persistent polling loop.
- Intended for a future "Force refresh" UI action — surfacing it as a user-triggered button is on the roadmap but not wired up today.
- `login()` already issues a one-off Sync probe on startup to verify the authcode, so initial catch-up happens automatically the first time the channel connects.

### Webhook Gotchas Confirmed in Production

1. **`/Webhook/Remove` clears the config, NOT the retry queue.** If a push fails for any reason, WCPPM parks it in an in-memory retry queue that survives `/Webhook/Remove` → `/Webhook/Set`, survives plugin restarts, and (as far as we can tell) only drains when the server process itself restarts or when the receiver returns 200.
2. **A queue item carries whatever `Signature` was computed at enqueue time.** Messages enqueued during a window when `webhookSecret` was empty on the WCPPM side keep an empty `body.Signature` forever — changing the secret later does NOT re-sign them. They'll 401 on every retry until you drain them.
3. **`/Webhook/Test` always signs with the currently-stored secret** (different code path). Test passing therefore does NOT prove the real-push path will pass — if the queue is poisoned, Test is green and real messages 401.
4. **Debug flow when signatures fail mysteriously** (`src/client.ts:1373+`):
   - Set `webhookDebug: true` — the 401 log line prints `signingInput`, expected/got HMAC prefixes, envelope top-level keys, HTTP header names, and stuffs the same diagnostic into a top-level `message` field of the 401 body (WCPPM's Go client extracts `.message` for 4xx responses; for 5xx it uses raw `body=`, which is why empty `message=` is the default look on 401).
   - If `gotLen=0`, you're in case 2 above (poisoned queue). Flip `webhookSilentDropUnsigned: true` to 200-and-drop those until the queue drains, then flip both flags off to restore strict mode.
5. **Doc gotcha**: the HMAC test vector in `docs/api-reference/docs/7359735m0.md:41` is wrong — the `df5fdd...` hex doesn't match HMAC-SHA256 of the shown input. Our implementation is correct (verified against openssl + the actual WCPPM `/Webhook/Test` signature). Don't chase the doc.

## OpenClaw-Side Enablement (web UI / openclaw.json)

The plugin manifest + channel config are not enough on their own — OpenClaw needs the plugin enabled and (optionally) a route binding. These live in `~/.openclaw/openclaw.json`, which is also what the OpenClaw web UI's config form writes to.

**Required:**
- `plugins.entries.wechatpadpro.enabled: true` — without this the plugin is loaded but skipped (`ui/src/ui/plugin-activation.ts`)
- `channels.wechatpadpro.{ host, authcode, webhookEnabled, ... }` — the channel account block (per-account `enabled` defaults to `true`)

**Optional, but worth knowing:**
- `bindings[]` — *not* required. If no entry matches `{ channel: "wechatpadpro", ... }`, `resolveAgentRoute` falls through to `default` at `src/routing/resolve-route.ts:835` and the message is routed to the default agent. It is **not** silently dropped (`dispatch.ts:76` is just defensive). Add a binding only if you need a non-default agent or per-peer routing.
- The web UI has no dedicated toggle for `plugins.entries.*.enabled` or `bindings[]` — edit `openclaw.json` directly (or via the web config editor).

## Webhook Deployment: Reverse-Proxy Mode

Recommended layout when exposing the webhook publicly:

```
WCPP MAX  ──HTTPS──▶  Caddy/nginx (public :8443)  ──HTTP──▶  127.0.0.1:8000/webhook (our plugin)
```

- `webhookHost: "127.0.0.1"` (default) — bind loopback only
- `webhookPort: 8000` (default) — local plain-HTTP listener
- `webhookPath: "/webhook"` (default) — the path the local server actually listens on
- `webhookUrl: "https://public.domain:port/webhook"` — **must include `/webhook`** (or whatever `webhookPath` is); the reverse proxy forwards path verbatim, so omitting it lands on `/` which 404s
- `webhookSecret: "<hex>"` — strongly recommended for any public URL; both ends share this and the plugin auto-pushes it to WCPP MAX in `/Webhook/Set`

The reverse proxy itself does **not** need any path rewrites; just upstream `127.0.0.1:8000`.

### Manual webhook registration on the WCPP MAX side

When `host` is configured, the plugin auto-calls `/Webhook/Set` on `gateway.startAccount`. In **passive mode** (host empty) the operator must register manually — same goes for `/Login/Newinit`, since without it the server's longlink stays down and **no push lands anywhere**, regardless of how correctly the webhook is wired:

```bash
# 1. (Required on 0412+) bring up the longlink
curl -X POST "http://<wcpp-max-host>:8062/api/Login/Newinit?authcode=<AUTHCODE>"

# 2. Register webhook
curl -X POST "http://<wcpp-max-host>:8062/api/Webhook/Set?authcode=<AUTHCODE>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<your-public-domain>:<port>/webhook",
    "secret": "<hex secret matching webhookSecret>",
    "enabled": true,
    "messageTypes": ["*"],
    "includeSelfMessage": false,
    "timeout": 5,
    "retryCount": 3
  }'
```

Verify with `GET /api/Webhook/Get?authcode=...` and trigger a test push with `POST /api/Webhook/Test?authcode=...`. The plugin's HMAC verifier expects `HMAC-SHA256(secret, "{Wxid}:{MessageType}:{Timestamp}")` hex-lowercase in the `Signature` field.

## WeChat Message Format

### Group Messages
`Content.string` = `sender_wxid:\nactual message text`
Must split on first `:\n` to extract sender and text.

### Private Messages
`Content.string` = raw text (no prefix)

### MsgType Reference
| MsgType | Meaning | Action |
|---------|---------|--------|
| 1 | Text | Pass through |
| 3 | Image (XML with CDN URL) | Pass through |
| 34 | Voice (XML with voiceurl) | Pass through |
| 47 | Sticker/emoji (XML with CDN URL) | Pass through |
| 48 | Location (XML with lat/lng/poiname/label) | Pass through |
| 49 | App/XML message (sub-types via `<type>` tag) | Parse `<title>`, pass through |
| 51 | Internal status sync (`<op id=2/5/7/9/11>`) | **Always drop** |
| 10002 | System message (dynacfg, revokemsg, etc.) | Drop except `revokemsg` |

### MsgType 49 Sub-types (check XML `<type>`)
- `57` = Quote/reply message
- `5` = Link card (URL in `<url>`) — includes 公众号文章分享
- `3` = Music share (QQ Music, etc. — `<dataurl>` has audio stream, `<url>` has web link)
- `8` = GIF/emoticon (sticker sent as app message)
- Image sometimes uses MsgType 3 instead of 49 sub-type

### MsgType 51 Op IDs (all noise, always filter)
- `2`/`5` = lastMessage read status sync
- `9` = Moments timeline update
- `7` = Moments unread status
- `11` = HandOff device switch

### MsgType 10002 Sub-types
- `dynacfg` = Dynamic config push (huge key-value blob) → drop
- `gog_wcs_plugin_config` = Risk control/strike → drop
- `ClientCheckGetExtInfo` = Device info collection → drop
- `EmotionBackup` = Sticker backup sync → drop
- `revokemsg` = Message recall notification → **keep** (if `passRevokemsg: true`)

## Sync Response Structure

```json
{
  "Code": 0,
  "Success": true,
  "Data": {
    "AddMsgs": [...],          // Incremental messages
    "ModContacts": [...],      // Contact updates (cache these)
    "ModUserInfos": [...],     // Self user info (contains wxid)
    "KeyBuf": {                // NEXT Synckey — pass this back
      "iLen": 349,
      "buffer": "base64..."   // Protobuf-encoded sync cursor
    },
    "Continue": 711176314,     // Continuation cookie
    "ContinueFlag": 18874624,  // Non-zero = more data to fetch
    "Time": 1775677433         // Server timestamp
  }
}
```

## Key Design Decisions

- **NormalizedMessage** unifies WS, Sync, and Webhook message formats so `channel.ts` doesn't care about transport
- **Contact cache** built from `ModContacts` in Sync responses; used for sender name resolution
- **Dedup by `NewMsgId`** (not `MsgId` — `MsgId` can repeat across sessions, `NewMsgId` is globally unique)
- **`readOnly` mode** blocks all outbound sends — for account stability during initial period
- **Age filter** drops messages older than `maxMessageAge` seconds (default 180) to avoid replaying stale history
- **DM gate is plugin-local**, not framework-enforced — see "DM policy gate" under the Inbound pipeline. The `security.dm` block on the plugin is metadata only; the actual gate lives in `channel.ts:buildDmAuthorizer` + `dispatch.ts`.

## Config Reference

```json
{
  "channels": {
    "wechatpadpro": {
      "host": "YOUR_HOST",               // Required for WebSocket + outbound; empty = passive webhook-only mode
      "port": 8062,
      "authcode": "...",                 // Required whenever host is set
      "wsUrl": "ws://HOST:8089/ws/sync", // Optional override; auto-constructed from host when empty

      "webhookEnabled": false,           // Also spin up a local webhook listener (additive inbound on top of WS)
      "webhookUrl": "https://your.public.domain:8443/webhook",  // Auto-registered via /Webhook/Set when host is set
      "webhookHost": "127.0.0.1",        // Default loopback; use 0.0.0.0 to expose directly
      "webhookPort": 8000,
      "webhookPath": "/webhook",
      "webhookSecret": "...",            // HMAC-SHA256 secret (strongly recommended)
      "webhookDebug": false,             // Leak diagnostic HMAC prefix on 401 for signature debugging
      "webhookSilentDropUnsigned": false, // Drain-the-queue escape hatch for unsigned retries

      "readOnly": true,                  // Receive-only, no sending
      "dmSecurity": "allow-all",         // "allowlist" | "allow-all" | "pairing"
      "allowFrom": ["wxid_xxx"],
      "allowMsgTypes": [1,3,34,47,48,49],
      "passRevokemsg": true,
      "maxMessageAge": 180
    }
  }
}
```

## Potential API Implementations (from WCPP MAX API surface)

Based on the available WeChatPadProMAX API, here are candidates for implementation in priority order:

### Implemented ✓
| API / Feature | Use Case | Status |
|-----|----------|--------|
| `POST /Msg/Quote` | Reply to/quote messages | ✅ Implemented — maps OpenClaw `reply_to` to WeChat quote |
| inbound message normalization | Make non-text messages readable in OpenClaw | ✅ Implemented — images/voice/stickers/cards/revokes render as short human-readable text |
| `POST /Tools/DownloadVoice` client helper | Download voice media from MsgType 34 | ✅ Implemented in client — extracts `bufid/fromUserName/length/msgId` and calls DownloadVoice |
| image/video metadata extraction | Prepare media downloads from XML payloads | ✅ Implemented in client — extracts AES key, CDN URLs, md5, lengths |
| `POST /Tools/DownloadImg` / `POST /Tools/DownloadVideo` helpers | Download media from image/video messages | ✅ Implemented in client as best-effort helpers with flexible payload assembly |
| unified media resolver | Let upstream code treat voice/image/video uniformly | ✅ Implemented via `resolveMedia()` / `isMediaMessage()` |
| channel inbound media integration | Surface media info to upper layers without extra parsing | ✅ Implemented — dispatch `raw` now includes `{ platform, normalized, media }` envelope |
| attachment-ready media bridge | Prepare media for future OpenClaw attachment ingestion | ✅ Implemented — each resolved media object now exposes `attachment` metadata and `materialize()` |
| Webhook receive mode | WCPP MAX pushes messages to our HTTP server | ✅ Implemented — `webhookEnabled: true`, auto-registers via `/Webhook/Set` when `host`+`webhookUrl` set, HMAC-SHA256 signature verification, converts to SyncMessage and reuses full pipeline |
| `/Webhook/Set` / `/Webhook/Get` / `/Webhook/Remove` / `/Webhook/Test` | Manage webhook config on WCPP MAX | ✅ Implemented in client + debug CLI (`webhook-set`, `webhook-get`, `webhook-remove`, `webhook-test`, `webhook-listen`) |

### High Priority — Core Messaging
| API | Use Case | Notes |
|-----|----------|-------|
| `POST /Msg/Revoke` | Revoke sent messages | User command `/revoke` or auto-revoke on edit |
| `POST /Tools/DownloadVoice` | Download voice messages (MsgType 34) | Request helper implemented; response handling is best-effort because provider response shape is not fully documented |
| `POST /Tools/DownloadImg` | Download HD images | Helper implemented, but exact provider payload contract still needs real response validation |
| `POST /Tools/DownloadVideo` | Download video files | Helper implemented, but exact provider payload contract still needs real response validation |
| `POST /Msg/SendVoice` | Send voice messages | File upload → voice message |
| `POST /Msg/SendVideo` | Send video messages | Payload confirmed from author's script: `ToWxid`, `PlayLength`, `Base64` (with `data:video/mp4;base64,` prefix), `ImageBase64` (with `data:image/jpeg;base64,` prefix). `thumbBase64` removed in 0416 |
| `POST /Msg/UploadImg` | Upload and send images | Current `SendImageNewMessage` may be limited |

### Medium Priority — Group & Contact Features
| API | Use Case |
|-----|----------|
| `POST /Group/GetChatRoomMemberDetail` | Better @ mention resolution (names instead of wxids) |
| `POST /Group/GetChatRoomInfoDetail` | Group announcements, topic, metadata |
| `POST /Friend/GetContractDetail` | Rich contact profiles |
| `POST /Friend/SetRemarks` | Set friend备注 |
| `POST /Group/SendPat` | "拍一拍" nudge functionality |

### Low Priority / Niche
| API | Use Case |
|-----|----------|
| `POST /Msg/SendApp` | Forward app/card messages |
| `POST /Msg/SendXCX` | Mini program messages | Author's script extracts `<appmsg>` from rawContent XML; swagger says `ToWxid`/`Content` (uppercase) but script uses lowercase `toWxid`/`content` |
| `POST /Msg/ShareCard` | Share contact cards |
| `POST /Msg/ShareLink` | Rich link previews |
| `POST /TenPay/*` | Red envelopes (probably not needed) |
| `POST /FriendCircle/*` | Moments/朋友圈 (read-only might be interesting) |

### Webhook Integration (Implemented ✓)
Core webhook APIs (`/Webhook/Set`, `/Get`, `/Remove`, `/Test`) are fully implemented. See "Implemented ✓" table above.

Remaining webhook APIs (low priority):
| API | Use Case |
|-----|----------|
| `GET /Webhook/Business/Get` | Get business callback URL |
| `POST /Webhook/Business/Set` | Set business callback URL |

### Out of Scope (server admin responsibility)
All `/Login/*`, `/Admin/*`, `/User/*` account management APIs.

## Known Issues

- Sync polling may return duplicate `PushContent` for the same message (reported by users in the WCPP community) — dedup handles this
- WCPP MAX authcode is single-use per login session; if the server restarts, a new authcode may be needed
- `@bot` detection in group chats relies on `<atuserlist>` in `MsgSource` XML — some clients may not include this; webhook delivery lacks `MsgSource` entirely, so on webhook-only paths @bot detection falls back to `pushContent` ("在群聊中@了你") only
- Voice messages (MsgType 34) now have client-side metadata extraction (`bufid`, `fromUserName`, `length`, `msgId`, `voiceurl`, `aeskey`)
- `downloadVoice(...)` is implemented against `/Tools/DownloadVoice`, but response payload shape is not fully documented, so JSON response decoding is best-effort
- `downloadImage(...)` / `downloadVideo(...)` are implemented as best-effort helpers using extracted XML metadata (`aesKey`, CDN URLs, md5, lengths, msgId, fromUserName)
- `resolveMedia(...)` returns a uniform `{ kind, info, download() }` object for voice/image/video messages so upper layers do not need per-type branching
- Channel dispatch now wraps inbound `raw` as `{ platform, normalized, media }`, making media metadata available to upper layers without reparsing XML
- Each resolved media object now also exposes attachment-ready metadata (`mimeType`, `fileName`, `extension`) plus `materialize(dir?)` to write a temp file for future attachment ingestion
- Current swagger access for some media endpoints has been flaky (`502`), so payload assembly is based on extracted metadata plus flexible request fields
- CDN-level direct media decryption/playback via raw CDN URLs + `aeskey` is still not implemented
- **SendTxt API uses `ToWxid` not `ToUserName`** — for users with custom WeChat IDs (e.g. "gxnnycz"), `ToWxid` must be the `UserName` string from search results, not the underlying `wxid_xxx`. Using the wxid returns `Ret: -2`
- **`Newinit` required on 0412+** — without calling `/Login/Newinit`, the server's longlink and unified dispatch pipeline remain inactive. The plugin now calls Newinit on startup by default
- **WCPP MAX 0416 fixes WS** — the 0412 WebSocket regression (immediate disconnect, code 1006) is resolved. WS connections are now stable and authenticated. The server also now supports RabbitMQ as a third downstream channel alongside WS and Webhook

## Account Safety Incident (2026-04-12)

**What happened:** Account was temporarily banned at 22:15 (UTC+8) after a debug session.

**Root cause:** Calling `Newinit` + `StartAutoSync` activated the server's unified dispatch pipeline, but all downstream channels were broken (WS: 0412 regression — fixed in 0416, Webhook: not configured). The server entered a tight loop — receiving data via longlink every few seconds, attempting to push to WS (fail) and Webhook (fail), repeating indefinitely. Tencent's risk detection flagged this abnormal high-frequency sync pattern over ~20 minutes and banned the account.

**Lessons / hard rules:**
1. **Never activate server-side auto-sync (`StartAutoSync`, `Newinit`) unless at least one downstream channel (WS, Webhook, or our Sync polling) is actively consuming data.** An active pipeline with no consumers creates a server-side retry storm that looks like abuse to Tencent.
2. **Rate-limit debug operations** — minimum 3-5 seconds between API calls; never probe multiple endpoints in rapid succession.
3. **Prefer reading server logs (via SSH + tmux) over hammering the API** when debugging connectivity issues.
4. **Do not call `Friend/Search` + `SendTxt` + `Newinit` + `StartAutoSync` in the same short session** — the combination of active operations across multiple API surfaces amplifies risk.
5. **Do not keep reconnecting WS in a tight loop** — the connect/disconnect pattern itself is suspicious (the 0412 WS regression that triggered this rule is fixed in 0416, but the principle stands).

## Debug Toolset

Standalone CLI for testing WCPP MAX API without running OpenClaw:

```bash
npm run debug status        # Check server + authcode validity
npm run debug newinit       # Establish longlink via /Login/Newinit
npm run debug heartbeat     # Send longlink heartbeat
npm run debug sync 5        # Poll /Msg/Sync 5 rounds
npm run debug ws 30         # Listen on WebSocket for 30s
npm run debug send gxnnycz "hello"  # Send text message
npm run debug search gxnnycz        # Search contact
npm run debug contacts      # List all contacts
npm run debug recv 120      # Newinit + live sync poll for 2 minutes

# Webhook commands
npm run debug webhook-set "http://OUR_IP:8000/webhook" [secret]  # Register webhook
npm run debug webhook-get          # Show current webhook config
npm run debug webhook-remove       # Remove webhook
npm run debug webhook-test         # Send test POST to webhook
npm run debug webhook-listen 8000 60  # Start local listener (port, seconds)
```

Reads config from `local-config.json`. Requires `npx tsx`.
