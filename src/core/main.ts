/**
 * main.ts — middleware entrypoint (the systemd --user service).
 *
 * Wires: config → SQLite → WcppClient (WeChat transport) → bridge server.
 *   inbound:  client.onMessage → handleInbound (dedup + persist) → server.broadcast
 *   outbound: server POST /send → client.sendText / sendQuote
 *
 * Account-safety: this only does what the existing plugin did — login() verifies
 * the authcode via a single Sync probe and connect() opens the push WS. It NEVER
 * calls /Login/Newinit or StartAutoSync (see CLAUDE.md).
 *
 * Run: node dist/core/main.js [configPath]   (default ~/.config/wcppm/config.json)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveConfig, type RawConfig } from "./config.js";
import { openDb } from "./db.js";
import { WcppClient } from "./client.js";
import { createBridgeServer, type ServerDeps } from "./server.js";
import { createSendHandler } from "./wiring.js";
import { handleInbound } from "./ingest.js";
import type { Logger } from "../shared/logger.js";

const logger: Logger = {
  info: (...a: unknown[]) => console.log("[wcppm]", ...a),
  warn: (...a: unknown[]) => console.warn("[wcppm]", ...a),
  error: (...a: unknown[]) => console.error("[wcppm]", ...a),
  debug: (...a: unknown[]) => {
    if (process.env.WCPPM_DEBUG) console.debug("[wcppm]", ...a);
  },
};

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
    `config: account=${cfg.account} bridge=${cfg.bridgeHost}:${cfg.bridgePort}` +
      ` db=${cfg.dbPath} wcppHost=${cfg.wcpp.host || "(passive)"}`,
  );

  const db = openDb(cfg.dbPath);
  const client = new WcppClient(cfg.wcpp, logger);

  let lastMsgTs: number | undefined;
  let wsUp = false;

  const send = createSendHandler(client);
  const deps: ServerDeps = {
    token: cfg.bridgeToken,
    ageWindowSeconds: cfg.ageWindowSeconds,
    db: {
      getUndelivered: (account, sinceTs) => db.getUndelivered(account, sinceTs),
      markDelivered: (id, at) => db.markDelivered(id, at),
    },
    send,
    forceSync: async () => {
      const r = await client.forceSync();
      return { ok: r.ok, messages: r.messages, hasMore: r.hasMore };
    },
    status: () => ({ wsUp, selfWxid: client.wxid ?? undefined, lastMsgTs }),
    selfWxid: () => client.wxid ?? undefined,
  };

  const server = createBridgeServer(deps);

  // Inbound: WeChat → dedup/persist → broadcast. One bad message must never
  // kill the receiver loop.
  client.onMessage = (msg) => {
    lastMsgTs = msg.createTime;
    try {
      handleInbound(msg, {
        account: cfg.account,
        db,
        broadcast: (frame) => server.broadcast(frame),
        resolveName: (wxid) => client.getContact(wxid)?.NickName?.string || undefined,
      });
    } catch (err) {
      logger.error("handleInbound failed:", err);
    }
  };

  // Verify auth / pick up selfWxid. In passive mode (no host) this returns
  // synthetic creds without contacting the server.
  const creds = await client.login();
  if (!creds) {
    logger.error("login/auth verification failed — check authcode/host");
    db.close();
    process.exitCode = 1;
    return;
  }

  // Bring up WeChat transports.
  if (cfg.wcpp.host) {
    client.connect();
    wsUp = true;
  }
  if (cfg.wcpp.webhookEnabled) {
    client.startWebhookServer();
    if (cfg.wcpp.host && cfg.wcpp.webhookUrl) {
      await client.registerWebhook();
    }
  }

  const port = await server.listen(cfg.bridgePort, cfg.bridgeHost);
  logger.info(`bridge up: ws://${cfg.bridgeHost}:${port}/subscribe · http://${cfg.bridgeHost}:${port}`);

  // Retention: prune inbound_log rows older than max(maxMessageAge, 1h).
  const retentionSec = Math.max(cfg.wcpp.maxMessageAge ?? 180, 3600);
  const pruneTimer = setInterval(() => {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - retentionSec;
      const removed = db.pruneInbound(cutoff);
      if (removed > 0) logger.debug(`pruned ${removed} inbound rows (> ${retentionSec}s old)`);
    } catch (err) {
      logger.error("prune failed:", err);
    }
  }, cfg.pruneIntervalMs);
  pruneTimer.unref?.();

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${sig}, shutting down…`);
    clearInterval(pruneTimer);
    try {
      client.disconnect();
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
