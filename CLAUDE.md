# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A two-part system bridging WeChat (via a WeChatPadProMax / "WCPPM" server) into OpenClaw:

1. **Standalone middleware** (`src/core/`) — owns the WeChat connection and runs as its **own process**. Receives via WS push / webhook, dedups, normalizes, persists, and exposes a small downstream interface (WS + HTTP).
2. **Thin OpenClaw adapter** (`src/adapters/openclaw/`) — an OpenClaw channel plugin that is just a *client* of the middleware. It runs the agent reply pipeline and the DM gate; it no longer talks to WeChat directly.

Why split: OpenClaw restarting no longer tears down the WeChat session; the WeChat core escapes OpenClaw SDK fragility, can be run/tested standalone, and is reusable by other bots over a clean WS+HTTP contract.

## Status / Orientation (read first)

- The standalone-middleware refactor (phases **P0→P2**) lives on branch **`feat/standalone-middleware`** and is **complete but NOT yet deployed**. `main` still carries the older in-process plugin.
- **Design spec:** `docs/superpowers/specs/2026-06-06-wcppm-standalone-middleware-design.md` (the source of truth for the architecture and the decisions behind it).
- **Deploy / go-live:** `deploy/README.md`.
- **Deep historical lore** (webhook signature debugging, Sync mechanics, the full MsgType table, past incidents) lives in **`CLAUDE.md.old`** — consult it when working on the WeChat protocol details inside `src/core/client.ts`.
- OpenClaw source (for plugin-SDK surfaces): `/home/radxa/openclaw-source-codes`. Offline WCPPM API mirror: `docs/api-reference/` (start at `INDEX.md`).

## Commands

```bash
npm run build        # tsc → dist/
npm test             # all src/**/*.test.ts via node:test (ExperimentalWarning silenced)
npm run debug <cmd>  # standalone WCPPM API CLI (status/ws/sync/send/...); reads local-config.json

# run one test file:
NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --test src/core/db.test.ts

# run the middleware (the systemd service entrypoint):
node --disable-warning=ExperimentalWarning dist/core/main.js [configPath]
#   configPath defaults to ~/.config/wcppm/config.json
```

Tests are colocated as `*.test.ts` and use Node's built-in `node:test` run through `tsx` (no Jest/Vitest). Development is **TDD** — write the failing test first.

## Architecture

```
remote WCPPM (Tailscale)  ──WS push / webhook──►  [ MIDDLEWARE: own process ]  ──WS /subscribe──►  OpenClaw adapter ──► agent
   HTTP 8062 / WS 8089     ◄──── /api/Msg/Send* ───  src/core/ (no OpenClaw deps)  ◄──── POST /send ───  src/adapters/openclaw/
```

**Middleware — `src/core/`** (must contain **zero** `openclaw/plugin-sdk` imports):
- `client.ts` — the WeChat API client: auth, WS push (`/ws/sync`), webhook receive, Sync, send (text/quote/image), media extract/download, contact cache. The engine. Produces `NormalizedMessage`.
- `proxy.ts` — undici dispatcher for outbound HTTP/WS (empty proxy = *explicit* direct, to bypass OpenClaw's process-global env proxy).
- `db.ts` — SQLite via built-in `node:sqlite` (no native dep). Two tables: `inbound_log` (dedup by stable id **and** replay/ack log) + `contacts` (name cache). `openDb` auto-creates the parent directory.
- `frame.ts` (`buildFrame`) + `shared/frame.ts` (the `Frame` type) — map a `NormalizedMessage` to the downstream wire `Frame`.
- `ingest.ts` (`handleInbound`) — per inbound message: build frame → record/dedup (persists **every** new message to SQLite **regardless of age**) → enrich names → broadcast **only if recent** (`maxBroadcastAge`). Dependency-injected, unit-tested apart from the live client/server.
- `server.ts` (`createBridgeServer`) — the downstream interface: `WS /subscribe` (bearer auth, sends `ready` then replays undelivered, accepts `{type:ack,id}`) and HTTP `POST /send` (text **and** media) / `POST /forceSync` / `POST /media` (lazy inbound fetch) / `GET /healthz` (`/healthz` is unauthenticated by design).
- `outbound-pacer.ts` (`createOutboundPacer`) — humanizing pacer wrapping the per-account send handler at the `/send` choke point (see the 2026-06-24 outbound-humanization note under Account Safety). **Default-off = transparent pass-through.** Pure-logic + injected clock/sleep/RNG, unit-tested.
- `config.ts` (`resolveConfig`) — middleware config + defaults; splits raw config into the WeChat-client config and the bridge config.
- `wiring.ts` / `main.ts` — `main.ts` is the entrypoint that wires config → SQLite → `WcppClient` → bridge server and handles signals/pruning.

**Adapter — `src/adapters/openclaw/`**:
- `bridge-client.ts` (`createBridgeClient`) — the link to the middleware: WS subscribe (auto-acks) + `send`/`forceSync` over HTTP. Plain WS+HTTP, no OpenClaw SDK, so it's testable against the real `core/server.ts`.
- `channel.ts` — the OpenClaw channel plugin (id `wechatpadpro`): gateway lifecycle, config adapter, DM gate; connects via `bridge-client`, maps inbound `Frame` → the dispatch shape. Also hosts the optional **inbound coalescer** (B): when `messages.inbound.debounceMs` > 0, a rapid same-sender burst is merged into one agent dispatch (`createInboundDebouncer`); 0 (default) = one dispatch per message.
- `dispatch.ts` — inbound → OpenClaw agent reply pipeline. **Transport-agnostic** (consumes a clean `WcppInboundMessage` + a `send` api), so it did not change in the cutover. Passes **`humanDelay`** (C, `resolveHumanDelayConfig`) into the reply dispatcher to pace multi-block answers; `undefined`/unconfigured = no delay.
- `shims/openclaw/*` — typecheck-only shims for `openclaw/plugin-sdk/*` (real impls provided by OpenClaw at runtime; mapped via tsconfig `paths`).

**Data flow:** WeChat → middleware (dedup/normalize/persist) → WS broadcast (Frame) → adapter → DM gate + agent → reply → `POST /send` → middleware → WeChat.

**Config split (two sides):**
- Middleware: `~/.config/wcppm/config.json` — WeChat `host`/`port`/`authcode`/`webhook*` **and** the bridge `bridgeToken`/`bridgePort`. See `config.example.json`.
- Adapter: `openclaw.json` → `channels.wechatpadpro` — only `bridgeUrl`, `bridgeToken`, `account`, `dmSecurity`, `allowFrom`, `groupAllowFrom`. `dmSecurity`/`allowFrom` gate **DMs only**; groups are gated separately by `groupAllowFrom` (empty = block all groups, `"*"` = allow all) and self-echoed frames are dropped — both enforced in `adapters/openclaw/gate.ts` *before* the agent pipeline, so non-allowlisted traffic costs zero tokens.

## Account Safety — HARD RULES (load-bearing, not derivable from code)

- **NEVER call `/Login/Newinit`** (full re-init — a top-tier risk-control / ban trigger) and **NEVER `StartAutoSync`**. An account was banned on 2026-04-12 from exactly this pattern (active dispatch with no live consumer → retry storm). The real-time push longlink is established **automatically at login, server-side** — we never "wake" it.
- **Startup is fully passive.** The middleware does **not** pull on connect (no startup `/Msg/Sync`) — it opens the WS push and waits. (`WcppClient.login()` still exists but is intentionally no longer called.)
- **`forceSync` is operator-only** (gateway RPC `wechatpadpro.forceSync` → middleware `POST /forceSync`): it performs **exactly one** `/api/Msg/Sync`, with **no `ContinueFlag` loop**, and the first call **omits `Synckey`** (`Scene 0`). Never auto-loop it.
- Prefer passive receive paths; avoid unnecessary active operations (account nurturing).

**2026-06-23 follow-up:** the **heartbeat surface** is now actively driven by the conductor in `src/heartbeat/` per spec `docs/superpowers/specs/2026-06-23-mars-heartbeat-conductor-design.md`. The "fully passive / never touch `/Login/*`" rule **no longer applies to `/Login/HeartBeat`** specifically — the conductor calls it on the Mars smart-heartbeat cadence (210–600 s adaptive, jittered). `/Login/Newinit`, `StartAutoSync`, and active `/Msg/Sync` remain **forbidden** (still ban triggers). The conductor **reads but never acts on** the heartbeat `Selector` field (no Sync triggered).

**2026-06-24 follow-up — outbound humanization (camouflage + rapid-outbound cap):** the reply path no longer sends instantly/24-7/every-message. Two layers, **all default-off / no-op until configured** (so steady-state behaviour is unchanged), tuned to resemble a real Mac client *and* to cap the rapid-outbound rate that caused the 2026-04-12 ban:
- **Middleware pacer** (`core/outbound-pacer.ts`, config `outboundPacer{}` in `config.example.json`, global + per-instance like heartbeat) — one pacer per account at the `/send` choke point, so it protects **every** consumer (adapter, operator forceSync, future bots): **A** a few-second length-scaled+jittered "read/compose" delay before the first send into an idle conversation (kills sub-second 秒回); **E** per-conversation min-gap + a **per-account** sliding-window ceiling (sends/min·/hour) that stretches under load, with a per-conversation queue-depth cap that **drops + loud-warns** as the hard backstop; **D** tz-aware quiet-hours that multiply the delay and lower the night ceiling (slows, does **not** defer-to-morning).
- **Adapter (OpenClaw SDK, configured in `openclaw.json`)** — **C** inter-block `humanDelay` (`agents.defaults.humanDelay`) paces multi-block answers; **B** inbound coalescing (`messages.inbound.debounceMs` / `byChannel.wechatpadpro`) merges a rapid same-sender burst into one agent dispatch (more human, fewer tokens, fewer replies).
- **`/send` contract change — ONLY when the pacer is enabled:** `/send` then **acks on enqueue** — the returned `ok:true` means "accepted into the pacer", **not** "delivered". A real send failure is logged middleware-side (`[pace]`), not surfaced synchronously; the adapter's "returned not-ok" check now only catches enqueue rejection (queue-cap drop). The queue is in-memory: a restart inside the seconds-scale delay window **drops** not-yet-sent replies (inbound is still persisted in SQLite → bounded, accepted loss).
- **Relation to the age gate:** orthogonal. `maxBroadcastAge` decides *whether* to reply (suppresses replies to old messages); the pacer only shapes the *timing* of replies that do happen. B/C and the pacer's min-gap both reduce/space outbound — bounded so they don't stack into sluggishness; turn them on incrementally and watch `[cfg] pacer=…` / `inboundDebounce=…` / `[pace]` (debug) lines.

## Scope Boundary (do not expand)

All `/Login/*`, `/User/*`, `/Admin/*` operations are the **WCPPM server operator's** responsibility, configured out-of-band. If messages don't arrive, the cause is login / `SyncKey` / `Identify` / webhook config — a server-side issue. **Do not "fix" it by adding active calls into those surfaces.**

## Conventions & Gotchas

- **Dedup by the stable global id** (NewMsgId-preferred; `NormalizedMessage.msgId` already resolves to it, falling back to `MsgId` only on JS precision loss). Plain `MsgId` can repeat across sessions.
- **Age gates *broadcast*, never *storage*.** The middleware is a lossless store: `client.ts:ingestSyncMessages` has **no CreateTime age filter** — every type/dedup-passing message is surfaced and persisted to SQLite (so a backlog redelivery / brief downtime gap is captured). Recency is enforced **only** on the agent dispatch, via `IngestDeps.maxBroadcastAge` (wired in `main.ts` from `maxMessageAge ?? 180`): a new-but-too-old message is stored (`handleInbound` returns `true`) but **not** broadcast. *Why it matters for safety:* a cold `forceSync` (Scene 0) can return a large batch of old history; dispatching it all to the agent would be a flood of auto-replies = a rapid-outbound **ban risk**. Never re-add a CreateTime drop in the client ingest path — to suppress *replies* to old messages, gate the broadcast, not the storage. (The webhook stale-doorbell skew check in `client.ts` is likewise a **debug**-level benign drop — the 0416 webhook is an empty doorbell.)
- **ESM**: relative imports carry `.js` extensions. `src/core/` must stay free of `openclaw/plugin-sdk` imports (it's the reusable, OpenClaw-independent layer). Code comments in English.
- **OpenClaw adapter wiring traps** (these silently break channel startup — check first if the channel loads but won't run):
  - `createChannelPluginBase` does **not** pass `gateway` through. Attach `gateway` as a sibling on the base object (see `channel.ts:wechatpadproBase`), never inside the helper call.
  - `config.isEnabled` must **not** call `isConfigured` — the gateway probes it with a stub account, which would falsely disable the channel. `isEnabled` reads `section.enabled` only.
- **Strict config validation (OpenClaw 2026.5.18+):** `channels.wechatpadpro` is validated against the manifest schema (`openclaw.plugin.json` → `channelConfigs.wechatpadpro.schema`, `additionalProperties:false`). Any config key not declared there fails the whole channel with a parent-only error path. Keep config keys and schema keys in sync.
- **Logging (`shared/logger.ts`):** `createLogger({debug,tags,color})` formats every line as `LEVEL [tag…] message` — `LEVEL` is a 5-char-padded `INFO `/`WARN `/`ERROR`/`DEBUG` (TTY-gated color on the level token; auto-off under journald so the journal stays escape-code-free). **No `[wcppm]` prefix** (the systemd unit + level identify lines). Levels mean **error** = needs attention · **warn** = recoverable/degraded · **info** = one-time lifecycle milestones + the hourly heartbeat liveness summary (otherwise stay quiet in steady state) · **debug** = per-event tracing. `main.ts` builds one root logger and one **`root.child(account)` per instance**, so every per-account line is auto-tagged `[account]` with no per-call-site work — pass the instance child (not the root) into that instance's `WcppClient`/sendHandler/mediaFetcher/heartbeat conductor; shared components (server, webhook listener) keep the root logger and carry `account=`/`wxid=` in-message. The whole inbound/downstream hot path (`ingest.ts` `[in]`, `server.ts` `[sub]`/`[send]`/`[sync]`) **and per-heartbeat-beat `[hb]`** are **debug-only**, gated by `WCPPM_DEBUG=1` in `main.ts` — default runs are quiet, set the env to trace end-to-end. Prefix every line with a bracketed **area tag** (`[in]`/`[sub]`/`[send]`/`[sync]`/`[ws]`/`[webhook]`/`[probe]`/`[net]`/`[hb]`/`[hb-net]`/`[cfg]`) so logs are greppable. **Steady-state liveness** (default, no `WCPPM_DEBUG`): per instance, hourly `[hb] alive:` (heartbeat) and `[in] alive:` (inbound msgs/1h, last-msg age, ws up/down, subscriber count); `[sub]` logs INFO when the first subscriber for an account connects and WARN when the last one drops (messages then stored-but-undelivered). `log` is a **required** field on `IngestDeps`/`ServerDeps` — wire it from `main.ts`. The base `Logger` interface stays `info/warn/error/debug` (so adapter/test consumers are unaffected); `child` lives on the `TaggableLogger` subtype that `createLogger` returns.
- **`npm run build` does NOT typecheck `*.test.ts` (they're excluded), and `npm test` runs with `--test-timeout=0`.** So a test whose deps object is missing a newly-**required** field won't fail the build — it throws at runtime deep in a handler and the test **hangs forever** instead of erroring. When you add a required field to a DI'd deps interface (`ServerDeps`/`IngestDeps`/…), grep for **every** consumer including tests (`fakeDeps`/`makeDeps`/inline literals). If a single test file hangs, suspect this first; run it alone wrapped in `timeout 60 …`.

## Current Limitations

- Outbound **media** over the bridge supports **image / video / file** (an `OutboundMedia` descriptor on `POST /send`; the middleware reads the url, infers the kind, dispatches via the matching MAX endpoint). Outbound **voice is NOT supported** yet (needs a SILK encoder).
- `WcppClient` (in `client.ts`) has grown large and is not yet split by responsibility; `login()` is now dead-ish (unused).
