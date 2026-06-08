/**
 * server.ts — downstream interface server for the WeChat middleware.
 *
 * Subscribers (OpenClaw adapter, future bots) connect over WebSocket to
 * receive real-time message frames and send acks. HTTP endpoints cover
 * outbound send, force-sync, and health checks.
 *
 * Design notes:
 * - One node:http server; WebSocketServer is attached in `noServer` mode.
 * - WS upgrade is only accepted on path `/subscribe`; all others are rejected.
 * - Auth: token query param OR Authorization: Bearer <token> header.
 * - /healthz is intentionally unauthenticated — it leaks no message data
 *   (just wsUp bool, selfWxid, and lastMsgTs), and needs to be reachable by
 *   load-balancers/monitoring without credentials.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Frame } from "../shared/frame.js";
import type { InboundRow } from "./db.js";
import type { Logger } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServerDeps {
  /** Shared bearer token required on every WS and HTTP request. */
  token: string;
  /** Structured logger. Downstream activity is traced at debug. */
  log: Logger;
  /** Replay/ack store (subset of Db). */
  db: {
    getUndelivered(account: string, sinceTs: number): InboundRow[];
    markDelivered(id: string, deliveredAt: number): void;
  };
  /** Outbound send (real impl wraps WcppClient.sendText/sendQuote). */
  send(req: {
    account?: string;
    to: string;
    text: string;
    replyTo?: string;
  }): Promise<{ ok: boolean; msgId?: string }>;
  /** One-shot catch-up (real impl wraps WcppClient.forceSync). */
  forceSync(account?: string): Promise<{ ok: boolean; messages?: number; hasMore?: boolean }>;
  /** Liveness/status for /healthz. */
  status(): { wsUp: boolean; selfWxid?: string; lastMsgTs?: number };
  /** selfWxid for the ready frame (may be undefined early). */
  selfWxid(): string | undefined;
  /** Replay age window in seconds (default 600). */
  ageWindowSeconds?: number;
  /** Injectable clock (ms since epoch). Default Date.now. Tests pass a fake. */
  now?: () => number;
  /** Read-only contact-cache search for the console (GET /contacts). Optional. */
  queryContacts?(account: string, q: string, limit: number): {
    wxid: string;
    name: string;
    type?: string;
    updatedAt: number;
  }[];
  /** Read-only recent-history query for the console (GET /history). Returns frames newest-first. Optional. */
  queryHistory?(account: string, chat: string | undefined, limit: number): Frame[];
}

export interface BridgeServer {
  /**
   * Push a frame to all connected subscribers.
   * Called by main on each new inbound message.
   */
  broadcast(frame: Frame): void;
  /**
   * Start listening. Resolves once bound.
   * host defaults to "127.0.0.1".
   * Returns the bound port number (useful when port=0 is passed for ephemeral port).
   */
  listen(port: number, host?: string): Promise<number>;
  /** Number of currently-connected WS subscribers. */
  subscriberCount(): number;
  /** Stop the server and close all sockets. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SubscriberMeta {
  account: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBridgeServer(deps: ServerDeps): BridgeServer {
  const now = deps.now ?? (() => Date.now());
  const ageWindowSeconds = deps.ageWindowSeconds ?? 600;
  const log = deps.log;

  // Map from WebSocket instance to its metadata (account).
  const subscribers = new Map<WebSocket, SubscriberMeta>();

  // ---------------------------------------------------------------------------
  // Auth helpers
  // ---------------------------------------------------------------------------

  function extractToken(req: IncomingMessage): string | null {
    // From Authorization: Bearer <token> header
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      return authHeader.slice("Bearer ".length).trim();
    }
    // From ?token= query param
    const url = new URL(req.url ?? "/", "http://host");
    return url.searchParams.get("token");
  }

  function isAuthorized(req: IncomingMessage): boolean {
    return extractToken(req) === deps.token;
  }

  // ---------------------------------------------------------------------------
  // HTTP request body helper
  // ---------------------------------------------------------------------------

  function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(payload);
  }

  // ---------------------------------------------------------------------------
  // HTTP server handler
  // ---------------------------------------------------------------------------

  // Track open HTTP sockets so close() can destroy them and not hang
  // waiting for keep-alive connections to time out.
  const httpSockets = new Set<import("node:net").Socket>();

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://host");
    const path = url.pathname;

    // GET /healthz — unauthenticated (see design note in file header)
    if (req.method === "GET" && path === "/healthz") {
      sendJson(res, 200, deps.status());
      return;
    }

    // POST /send
    if (req.method === "POST" && path === "/send") {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const body = (await readBody(req)) as Parameters<typeof deps.send>[0];
        const result = await deps.send(body);
        log.debug(
          `[send] to=${body.to} replyTo=${body.replyTo ?? "-"} ok=${result.ok}` +
            (result.msgId ? ` msgId=${result.msgId}` : ""),
        );
        sendJson(res, 200, result);
      } catch (err) {
        log.error("[send] failed:", err);
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /forceSync
    if (req.method === "POST" && path === "/forceSync") {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const body = (await readBody(req)) as Record<string, unknown>;
        const account = typeof body.account === "string" ? body.account : undefined;
        const result = await deps.forceSync(account);
        log.debug(
          `[sync] forceSync account=${account ?? "default"} → ok=${result.ok}` +
            ` messages=${result.messages ?? 0} hasMore=${result.hasMore ?? false}`,
        );
        sendJson(res, 200, result);
      } catch (err) {
        log.error("[sync] forceSync failed:", err);
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /contacts?q=&account=&limit= — read-only contact-cache search
    if (req.method === "GET" && path === "/contacts") {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const account = url.searchParams.get("account") || "default";
      const q = url.searchParams.get("q") || "";
      const limitRaw = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
      sendJson(res, 200, deps.queryContacts?.(account, q, limit) ?? []);
      return;
    }

    // GET /history?account=&chat=&limit= — read-only recent inbound frames
    if (req.method === "GET" && path === "/history") {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const account = url.searchParams.get("account") || "default";
      const chat = url.searchParams.get("chat") || undefined;
      const limitRaw = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
      sendJson(res, 200, deps.queryHistory?.(account, chat, limit) ?? []);
      return;
    }

    // Fallthrough
    sendJson(res, 404, { error: "not found" });
  });

  // ---------------------------------------------------------------------------
  // Track open HTTP sockets so close() can tear them down
  httpServer.on("connection", (socket) => {
    httpSockets.add(socket);
    socket.once("close", () => httpSockets.delete(socket));
  });

  // ---------------------------------------------------------------------------
  // WebSocket server (noServer — we handle upgrade manually)
  // ---------------------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://host");

    // Only accept upgrades on /subscribe
    if (url.pathname !== "/subscribe") {
      socket.destroy();
      return;
    }

    // Auth check on the token query param (Authorization header is not
    // available in the HTTP upgrade handshake in the same way, but ws
    // does pass req.headers — so we handle both for completeness)
    const token = url.searchParams.get("token") ??
      (() => {
        const authHeader = req.headers["authorization"];
        if (authHeader && authHeader.startsWith("Bearer ")) {
          return authHeader.slice("Bearer ".length).trim();
        }
        return null;
      })();

    if (token !== deps.token) {
      // Reject with close code 4401. Complete the WS handshake first so
      // the client receives a proper WebSocket close frame rather than a
      // raw TCP RST (the ws library handles this if we handleProtocols).
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(4401, "Unauthorized");
      });
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    const url = new URL((req as IncomingMessage).url ?? "/", "http://host");
    const account = url.searchParams.get("account") ?? "default";
    const sinceParam = url.searchParams.get("since");
    const sinceTs = sinceParam ? Number(sinceParam) : undefined;

    subscribers.set(ws, { account });
    log.debug(`[sub] connected account=${account} total=${subscribers.size}`);

    // Defer the initial ready + replay sends so they happen after the
    // current I/O cycle. This avoids a race where the server sends the
    // ready frame synchronously during the connection event (before the
    // client's "open" promise can resolve and the test can attach a
    // "message" listener). setImmediate fires after microtasks, so the
    // await-open + await-message sequence in tests is deterministic.
    setImmediate(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      // 1. Send ready frame
      const readyFrame = { type: "ready", selfWxid: deps.selfWxid() ?? "" };
      ws.send(JSON.stringify(readyFrame));

      // 2. Replay undelivered rows after ready frame
      const windowStart = sinceTs ?? (now() / 1000 - ageWindowSeconds);
      const undelivered = deps.db.getUndelivered(account, windowStart);
      for (const row of undelivered) {
        ws.send(row.payload);
      }
      log.debug(`[sub] ready+replay account=${account} undelivered=${undelivered.length}`);
    });

    // 3. Handle inbound messages from subscriber (acks, etc.)
    ws.on("message", (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        // Ignore malformed messages
        return;
      }
      if (
        msg !== null &&
        typeof msg === "object" &&
        (msg as Record<string, unknown>).type === "ack" &&
        typeof (msg as Record<string, unknown>).id === "string"
      ) {
        const id = (msg as Record<string, unknown>).id as string;
        deps.db.markDelivered(id, now());
        log.debug(`[sub] ack id=${id}`);
      }
    });

    // 4. Clean up on disconnect
    ws.on("close", () => {
      subscribers.delete(ws);
      log.debug(`[sub] disconnected account=${account} total=${subscribers.size}`);
    });
  });

  // ---------------------------------------------------------------------------
  // BridgeServer implementation
  // ---------------------------------------------------------------------------

  return {
    broadcast(frame: Frame): void {
      const payload = JSON.stringify(frame);
      for (const [ws] of subscribers) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      }
    },

    listen(port: number, host = "127.0.0.1"): Promise<number> {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          const addr = httpServer.address();
          if (!addr || typeof addr === "string") {
            reject(new Error("unexpected address type"));
            return;
          }
          resolve(addr.port);
        });
      });
    },

    subscriberCount(): number {
      return subscribers.size;
    },

    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        // Terminate all WebSocket clients tracked by the WS server
        // (covers both authenticated subscribers and rejected clients
        // still in a graceful-close handshake)
        for (const ws of wss.clients) {
          ws.terminate();
        }
        subscribers.clear();

        // Destroy all tracked HTTP sockets (handles keep-alive connections)
        for (const socket of httpSockets) {
          socket.destroy();
        }
        httpSockets.clear();

        // Close the HTTP server first (stops accepting new connections).
        // The WS server is closed without waiting for its callback since
        // we already terminated all clients — wss.close() fires its
        // callback only after all clients remove themselves from wss.clients,
        // which happens asynchronously after terminate(), causing a race.
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        // Close wss in parallel (best-effort cleanup); we don't await it.
        wss.close();
      });
    },
  };
}
