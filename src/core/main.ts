/**
 * main.ts — middleware entrypoint (the systemd --user service).
 *
 * Wires: config → SQLite → N WcppClients (one per WeChat instance) → bridge server.
 *   inbound:  client.onMessage → handleInbound (dedup + persist) → server.broadcast
 *   outbound: server POST /send → the owning instance's sendText / sendQuote
 *
 * Multi-instance: each config instance gets its own WcppClient (own auth, WS push,
 * dedup set, contact cache) and its own heartbeat conductor. All instances share
 * ONE db, ONE bridge server, and ONE webhook listener (routed to the owning client
 * by self-`Wxid`). Every bridge callback (send/forceSync/media/status/selfWxid/…)
 * selects the instance by `account`.
 *
 * Account-safety: startup is passive — connect() opens the WS push and (for this
 * deployment) the shared webhook listener receives pushes. It NEVER calls
 * /Login/Newinit or StartAutoSync, and never auto-Syncs on a webhook (see CLAUDE.md).
 *
 * Run: node dist/core/main.js [configPath]   (default ~/.config/wcppm/config.json)
 */
import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveConfig, type RawConfig } from "./config.js";
import { openDb } from "./db.js";
import { WcppClient, type WcppConfig } from "./client.js";
import { createBridgeServer, type ServerDeps } from "./server.js";
import { createSendHandler, createMediaFetcher } from "./wiring.js";
import { createWebhookListener, type WebhookSink } from "./webhook-listener.js";
import { handleInbound } from "./ingest.js";
import { startHeartbeatConductor } from "../heartbeat/runtime.js";
import type { HeartbeatConfig } from "../heartbeat/runtime.js";
import { createLogger } from "../shared/logger.js";
import type { Logger } from "../shared/logger.js";
import type { Frame } from "../shared/frame.js";

// Root logger. Debug is gated by WCPPM_DEBUG; per-instance lines are tagged with
// the account via root.child(account) below so multi-account logs stay readable.
const logger = createLogger({ debug: Boolean(process.env.WCPPM_DEBUG) });

/** A running WeChat instance and its per-account state. */
interface Instance {
  account: string;
  wcpp: WcppConfig;
  heartbeat: HeartbeatConfig;
  /** Per-instance logger (root.child(account)) — auto-tags every line `[account]`. */
  log: Logger;
  client: WcppClient;
  send: ReturnType<typeof createSendHandler>;
  fetchMedia: ReturnType<typeof createMediaFetcher>;
  hb?: { stop(): Promise<void> | void } | null;
  wsUp: boolean;
  lastMsgTs?: number;
  /** Inbound messages received since the last hourly liveness summary. */
  msgsInWindow: number;
}

/**
 * Delete media files in `dir` whose mtime is older than `cutoffMs`. Best-effort
 * and silent on a missing dir (nothing downloaded yet). Keeps the lazy-download
 * scratch dir bounded; the DB descriptor rows are pruned separately.
 */
function pruneMediaFiles(dir: string, cutoffMs: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // dir not created yet (no media downloaded) — nothing to do
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      if (statSync(full).mtimeMs < cutoffMs) unlinkSync(full);
    } catch {
      /* ignore individual file errors (race with a concurrent download, etc.) */
    }
  }
}

function loadRawConfig(path: string): RawConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawConfig;
  } catch (err) {
    throw new Error(`failed to read config at ${path}: ${String(err)}`);
  }
}

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? join(homedir(), ".config", "wcppm", "config.json");
  const cfg = resolveConfig(loadRawConfig(configPath));
  logger.info(
    `config: instances=[${cfg.instances.map((i) => i.account).join(", ")}]` +
      ` bridge=${cfg.bridgeHost}:${cfg.bridgePort} db=${cfg.dbPath}` +
      ` webhook=${cfg.webhook.enabled ? `${cfg.webhook.host}:${cfg.webhook.port}${cfg.webhook.path}` : "off"}`,
  );

  const db = openDb(cfg.dbPath);

  // Lazy media download directory. Shared filesystem with the adapter (same
  // box/user), so the localPath we return is directly readable downstream.
  const mediaDir = cfg.mediaDir;

  // Build one client per instance. onMessage is wired AFTER the server exists.
  const instances = new Map<string, Instance>();
  for (const inst of cfg.instances) {
    const log = logger.child(inst.account);
    const client = new WcppClient(inst.wcpp, log);
    instances.set(inst.account, {
      account: inst.account,
      wcpp: inst.wcpp,
      heartbeat: inst.heartbeat,
      log,
      client,
      send: createSendHandler(client),
      fetchMedia: createMediaFetcher(client, db, { dir: mediaDir, log }),
      wsUp: false,
      msgsInWindow: 0,
    });
    // One-line per-instance config snapshot at startup so misconfig is obvious
    // on boot (mode is otherwise only discoverable per-event).
    log.info(
      `[cfg] host=${inst.wcpp.host ?? "(webhook-only)"}:${inst.wcpp.port}` +
        ` hb=${inst.heartbeat.enabled ? "on" : "off"}` +
        ` maxAge=${inst.wcpp.maxMessageAge ?? 180}s readOnly=${Boolean(inst.wcpp.readOnly)}`,
    );
    if (inst.wcpp.readOnly) log.warn("[cfg] read-only mode — outbound sends are disabled");
  }

  /** Select the instance for an account. With a single instance, an omitted account resolves to it. */
  const instanceFor = (account?: string): Instance | undefined => {
    if (account) return instances.get(account);
    return instances.size === 1 ? instances.values().next().value : undefined;
  };

  const deps: ServerDeps = {
    token: cfg.bridgeToken,
    log: logger,
    ageWindowSeconds: cfg.ageWindowSeconds,
    db: {
      getUndelivered: (account, sinceTs) => db.getUndelivered(account, sinceTs),
      markDelivered: (account, id, at) => db.markDelivered(account, id, at),
    },
    send: (req) => {
      const inst = instanceFor(req.account);
      if (!inst) {
        logger.warn(`[send] no instance for account=${req.account}`);
        return Promise.resolve({ ok: false });
      }
      return inst.send(req);
    },
    forceSync: async (account) => {
      const inst = instanceFor(account);
      if (!inst) return { ok: false };
      const r = await inst.client.forceSync();
      return { ok: r.ok, messages: r.messages, hasMore: r.hasMore };
    },
    // Lazy media fetch: download the bytes for a previously-broadcast media frame
    // (operator-safe — /Tools/DownloadImg, not a /Login or /Msg/Sync call).
    fetchMedia: (account, id) => {
      const inst = instanceFor(account);
      if (!inst) return Promise.resolve({ ok: false });
      return inst.fetchMedia(account, id);
    },
    status: () => {
      let wsUp = false;
      let selfWxid: string | undefined;
      let lastMsgTs: number | undefined;
      for (const inst of instances.values()) {
        if (inst.wsUp) wsUp = true;
        if (!selfWxid && inst.client.wxid) selfWxid = inst.client.wxid;
        if (inst.lastMsgTs && (lastMsgTs === undefined || inst.lastMsgTs > lastMsgTs)) lastMsgTs = inst.lastMsgTs;
      }
      return { wsUp, selfWxid, lastMsgTs };
    },
    selfWxid: (account) => instanceFor(account)?.client.wxid ?? undefined,
    queryContacts: (account, q, limit) =>
      db.searchContacts(account, q, limit).map((c) => ({
        wxid: c.wxid,
        name: c.name,
        type: c.type ?? undefined,
        updatedAt: c.updated_at,
      })),
    queryHistory: (account, chat, limit) => {
      // inbound_log has no chat column; over-fetch then filter parsed frames by chat.
      const fetchN = chat ? Math.min(limit * 20, 500) : limit;
      const rows = db.recentInbound(account, fetchN);
      let frames = rows
        .map((r) => {
          try {
            return JSON.parse(r.payload) as Frame;
          } catch {
            return undefined;
          }
        })
        .filter((f): f is Frame => f !== undefined);
      if (chat) frames = frames.filter((f) => f.chat.id === chat || f.chat.name === chat);
      return frames.slice(0, limit);
    },
  };

  const server = createBridgeServer(deps);

  // Inbound: WeChat → dedup/persist → broadcast (per instance). One bad message
  // must never kill a receiver loop.
  for (const inst of instances.values()) {
    inst.client.onMessage = (msg) => {
      inst.lastMsgTs = msg.createTime;
      inst.msgsInWindow++;
      try {
        handleInbound(msg, {
          account: inst.account,
          db,
          log: inst.log,
          broadcast: (frame) => server.broadcast(frame),
          resolveName: (wxid) => inst.client.getContact(wxid)?.NickName?.string || undefined,
          // Persist every new message regardless of age, but only dispatch recent
          // ones to the agent (a backlog redelivery is captured but not replayed).
          maxBroadcastAge: inst.wcpp.maxMessageAge ?? 180,
        });
      } catch (err) {
        inst.log.error("[in] handleInbound failed:", err);
      }
    };
  }

  // Shared webhook listener: ONE port for all instances, routed to the owning
  // client by self-Wxid. Prefer the config-declared wxid; fall back to a learned
  // one so routing works even before a wxid is configured.
  const routeWebhook = (wxid: string): WebhookSink | undefined => {
    for (const inst of instances.values()) {
      if (inst.wcpp.wxid === wxid || inst.client.wxid === wxid) {
        return { account: inst.account, ingestWebhookEnvelope: (e) => inst.client.ingestWebhookEnvelope(e) };
      }
    }
    return undefined;
  };
  const webhookListener = cfg.webhook.enabled
    ? createWebhookListener({ config: cfg.webhook, log: logger, route: routeWebhook })
    : undefined;
  if (webhookListener) await webhookListener.listen();

  // Bring up WeChat transports PASSIVELY — no startup /Msg/Sync probe. connect()
  // opens the WS push when host is set; the per-instance webhook server stays
  // disabled (the shared listener above owns webhook receive). forceSync stays
  // operator-only.
  for (const inst of instances.values()) {
    inst.client.connect();
    if (inst.wcpp.host) {
      inst.wsUp = true;
      inst.log.info(`[ws] connecting WS push to ${inst.wcpp.host} (passive; no startup Sync)`);
    } else {
      inst.log.info("[ws] passive webhook-only mode (no host)");
    }
  }

  const port = await server.listen(cfg.bridgePort, cfg.bridgeHost);
  logger.info(`bridge up: ws://${cfg.bridgeHost}:${port}/subscribe · http://${cfg.bridgeHost}:${port}`);

  // One heartbeat conductor per instance, each with its own (global + per-instance
  // override) heartbeat config. The redis netKey is namespaced by host:port, so two
  // instances sharing an authcode keep independent heartbeat state.
  for (const inst of instances.values()) {
    inst.hb = startHeartbeatConductor(inst.heartbeat, inst.wcpp, inst.log);
  }

  // Retention: prune inbound_log/media rows older than max(maxMessageAge, 1h).
  const maxRetentionAge = Math.max(...cfg.instances.map((i) => i.wcpp.maxMessageAge ?? 180), 180);
  const retentionSec = Math.max(maxRetentionAge, 3600);
  const pruneTimer = setInterval(() => {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - retentionSec;
      const removed = db.pruneInbound(cutoff);
      const removedMedia = db.pruneMedia(cutoff);
      if (removed > 0 || removedMedia > 0) {
        logger.debug(`pruned ${removed} inbound + ${removedMedia} media rows (> ${retentionSec}s old)`);
      }
      pruneMediaFiles(mediaDir, Date.now() - retentionSec * 1000);
    } catch (err) {
      logger.error("prune failed:", err);
    }
  }, cfg.pruneIntervalMs);
  pruneTimer.unref?.();

  // Inbound liveness: an hourly per-instance INFO pulse mirroring the heartbeat
  // summary. The receive path is otherwise silent in steady state, so if pushes
  // stall this surfaces "0 msgs/1h" instead of total silence. INFO not WARN — a
  // genuinely quiet chat legitimately produces zero messages.
  const HOUR_MS = 3_600_000;
  const livenessTimer = setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const inst of instances.values()) {
      const lastAge = inst.lastMsgTs ? `${nowSec - inst.lastMsgTs}s ago` : "never";
      inst.log.info(
        `[in] alive: ${inst.msgsInWindow} msgs/1h last ${lastAge}` +
          ` ws=${inst.wsUp ? "up" : "down"} subs=${server.subscriberCount(inst.account)}`,
      );
      inst.msgsInWindow = 0;
    }
  }, HOUR_MS);
  livenessTimer.unref?.();

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${sig}, shutting down…`);
    clearInterval(pruneTimer);
    clearInterval(livenessTimer);
    for (const inst of instances.values()) {
      try {
        inst.client.disconnect();
      } catch {
        /* ignore */
      }
      try {
        await inst.hb?.stop();
      } catch {
        /* ignore */
      }
    }
    try {
      await webhookListener?.close();
    } catch {
      /* ignore */
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("middleware up.");
}

main().catch((err) => {
  console.error("[wcppm] fatal:", err);
  process.exit(1);
});
