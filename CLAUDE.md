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
- `server.ts` (`createBridgeServer`) — the downstream interface: `WS /subscribe` (bearer auth, sends `ready` then replays undelivered, accepts `{type:ack,id}`) and HTTP `POST /send` / `POST /forceSync` / `GET /healthz` (`/healthz` is unauthenticated by design).
- `config.ts` (`resolveConfig`) — middleware config + defaults; splits raw config into the WeChat-client config and the bridge config.
- `wiring.ts` / `main.ts` — `main.ts` is the entrypoint that wires config → SQLite → `WcppClient` → bridge server and handles signals/pruning.

**Adapter — `src/adapters/openclaw/`**:
- `bridge-client.ts` (`createBridgeClient`) — the link to the middleware: WS subscribe (auto-acks) + `send`/`forceSync` over HTTP. Plain WS+HTTP, no OpenClaw SDK, so it's testable against the real `core/server.ts`.
- `channel.ts` — the OpenClaw channel plugin (id `wechatpadpro`): gateway lifecycle, config adapter, DM gate; connects via `bridge-client`, maps inbound `Frame` → the dispatch shape.
- `dispatch.ts` — inbound → OpenClaw agent reply pipeline. **Transport-agnostic** (consumes a clean `WcppInboundMessage` + a `send` api), so it did not change in the cutover.
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
- **Logging (`shared/logger.ts`):** levels mean **error** = needs attention · **warn** = recoverable/degraded · **info** = one-time lifecycle milestones only (stay quiet in steady state) · **debug** = per-event tracing. The whole inbound/downstream hot path (`ingest.ts` `[in]`, `server.ts` `[sub]`/`[send]`/`[sync]`) is **debug-only**, gated by `WCPPM_DEBUG=1` in `main.ts`'s logger — default runs are quiet, set the env to trace a message end-to-end. Prefix every line with a bracketed **area tag** (`[in]`/`[sub]`/`[send]`/`[sync]`/`[ws]`/`[webhook]`/`[probe]`/`[net]`) so logs are greppable; the global `[wcppm]` prefix is added by the impl. `log` is a **required** field on `IngestDeps`/`ServerDeps` — wire it from `main.ts`.
- **`npm run build` does NOT typecheck `*.test.ts` (they're excluded), and `npm test` runs with `--test-timeout=0`.** So a test whose deps object is missing a newly-**required** field won't fail the build — it throws at runtime deep in a handler and the test **hangs forever** instead of erroring. When you add a required field to a DI'd deps interface (`ServerDeps`/`IngestDeps`/…), grep for **every** consumer including tests (`fakeDeps`/`makeDeps`/inline literals). If a single test file hangs, suspect this first; run it alone wrapped in `timeout 60 …`.

## Current Limitations

- Outbound **media** is not yet supported over the bridge (middleware `POST /send` is text-only — add a `/sendMedia` endpoint to enable it).
- `WcppClient` (in `client.ts`) has grown large and is not yet split by responsibility; `login()` is now dead-ish (unused).
