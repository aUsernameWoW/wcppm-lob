/**
 * webhook-listener.ts — the ONE shared webhook HTTP listener for all instances.
 *
 * WCPP MAX pushes a signed envelope (see WebhookEnvelope). With multiple WeChat
 * instances behind one middleware we run a single listener on one port and route
 * each push to the owning instance by its self-`Wxid`:
 *
 *   POST /webhook  ──parse──►  verify HMAC (shared secret)  ──►  route(envelope.Wxid)
 *                                                                   └─► sink.ingestWebhookEnvelope
 *
 * Routing by Wxid (not by port) keeps a webhook and its account's WS push on the
 * SAME WcppClient, so the in-memory dedup set catches the cross-transport
 * duplicate (WS push arrives first; the webhook copy a few seconds later is dropped).
 *
 * We ALWAYS answer 200 for a parseable body (even on drops) so WCPPM drains its
 * retry queue rather than retry-storming. We never Sync in response — the inline
 * messages the envelope already carries are enough (an empty doorbell is a no-op).
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";

import { verifyWebhookSignature, type WebhookEnvelope } from "./client.js";
import type { WebhookListenerConfig } from "./config.js";
import type { Logger } from "../shared/logger.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const SKEW_WINDOW_SECONDS = 900; // 15 min anti-replay window (matches the in-client server)

/** The owning instance a routed webhook is handed to. */
export interface WebhookSink {
  account: string;
  ingestWebhookEnvelope(envelope: WebhookEnvelope): void;
}

export interface WebhookListenerDeps {
  config: WebhookListenerConfig;
  log: Logger;
  now?: () => number; // ms; injectable for tests
  /** Resolve a self-wxid (from the envelope) to the owning instance's sink, or undefined. */
  route(wxid: string): WebhookSink | undefined;
}

export interface WebhookListener {
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createWebhookListener(deps: WebhookListenerDeps): WebhookListener {
  const { config, log, route } = deps;
  const now = deps.now ?? (() => Date.now());
  const basePath = config.path;

  const server: HttpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith(basePath)) {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = "";
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (bodyTooLarge) return;
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        bodyTooLarge = true;
        log.warn(`[webhook] body exceeded ${MAX_BODY_BYTES} bytes, rejecting (413)`);
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "payload too large" }));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => {
      if (bodyTooLarge) return;
      log.debug(`[webhook] raw ${body}`);
      let envelope: WebhookEnvelope;
      try {
        envelope = JSON.parse(body) as WebhookEnvelope;
      } catch (e) {
        log.debug("[webhook] parse error", e);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
        return;
      }

      const ack = (payload: Record<string, unknown>) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      // Signature verification against the ONE shared secret.
      if (config.secret) {
        const verdict = verifyWebhookSignature(envelope, config.secret);
        if (!verdict.ok) {
          if (verdict.gotLen === 0 && config.silentDropUnsigned) {
            log.warn(`[webhook] silently dropping unsigned push (wxid=${envelope.Wxid}, ts=${envelope.Timestamp})`);
            ack({ ok: true, dropped: true, reason: "unsigned" });
            return;
          }
          if (config.debug) {
            log.warn(
              `[webhook] signature verification failed — input="${verdict.signingInput}" ` +
                `expected=${verdict.expectedPrefix}.. got=${verdict.gotPrefix}.. gotLen=${verdict.gotLen}`,
            );
          } else {
            log.warn("[webhook] signature verification failed (enable webhookDebug for details)");
          }
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid signature" }));
          return;
        }
      }

      // Anti-replay skew: a stale doorbell is a benign backlog redelivery. Ack 200
      // (so WCPPM drains its retry queue) and drop. Real messages flow over WS push.
      if (Math.abs(now() / 1000 - envelope.Timestamp) > SKEW_WINDOW_SECONDS) {
        const ageSec = Math.round(now() / 1000 - envelope.Timestamp);
        log.debug(`[webhook] dropping stale push (wxid=${envelope.Wxid}, ts=${envelope.Timestamp}, age=${ageSec}s)`);
        ack({ ok: false, warning: "timestamp skew" });
        return;
      }

      // Route to the owning instance by self-wxid.
      const sink = route(envelope.Wxid);
      if (!sink) {
        // Unknown wxid: benign (likely a duplicate of a WS-push message we already
        // have, or an instance not yet wired). Ack so WCPPM stops retrying.
        log.debug(`[webhook] no instance for wxid=${envelope.Wxid}; dropping`);
        ack({ ok: true, dropped: true, reason: "unrouted" });
        return;
      }

      try {
        sink.ingestWebhookEnvelope(envelope);
      } catch (e) {
        log.error(`[webhook] ingest failed for account=${sink.account}`, e);
      }
      ack({ ok: true });
    });
  });

  return {
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          const addr = server.address();
          const port = addr && typeof addr !== "string" ? addr.port : config.port;
          log.info(`[webhook] shared listener on ${config.host}:${port}${basePath}`);
          resolve(port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
