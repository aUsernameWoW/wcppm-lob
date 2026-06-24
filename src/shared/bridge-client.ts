/**
 * bridge-client.ts — the OpenClaw adapter's connection to the standalone
 * middleware. Subscribes over WebSocket for inbound frames (auto-acking each)
 * and POSTs outbound sends. This is plain WS+HTTP — no OpenClaw SDK — so it is
 * testable against the real core/server.ts without OpenClaw or a live WCPPM.
 *
 * Outbound HTTP uses an explicit direct undici dispatcher: OpenClaw installs a
 * process-global EnvHttpProxyAgent, and a bare fetch() to our loopback bridge
 * could otherwise be routed through an ambient proxy (see core/proxy.ts).
 */
import WebSocket from "ws";
import { fetch as undiciFetch } from "undici";

import { buildProxyTransport } from "../core/proxy.js";
import type { Frame } from "./frame.js";
import type { Logger } from "./logger.js";

export interface BridgeClientOpts {
  /** WS base URL of the middleware, e.g. ws://127.0.0.1:8077 */
  url: string;
  token: string;
  account?: string;
  onMessage: (frame: Frame) => void;
  onReady?: (selfWxid: string) => void;
  /** Called when the WS closes unexpectedly (before a reconnect attempt). */
  onDisconnect?: () => void;
  log?: Logger;
  /** Auto-ack each received message frame (default true). */
  autoAck?: boolean;
  /** Reconnect backoff after an unexpected close (default 3000ms). */
  reconnectDelayMs?: number;
}

export interface SendRequest {
  to: string;
  text: string;
  replyTo?: string;
  account?: string;
}

export interface BridgeClient {
  connect(): void;
  close(): void;
  send(req: SendRequest): Promise<{ ok: boolean; msgId?: string }>;
  forceSync(account?: string): Promise<{ ok: boolean; messages?: number; hasMore?: boolean }>;
  /**
   * Lazily fetch the bytes for a media frame (image, …). The middleware
   * downloads them to a local path on the shared filesystem and returns it.
   * Call this AFTER the inbound gate so only media we'll dispatch is downloaded.
   */
  fetchMedia(id: string, account?: string): Promise<{ ok: boolean; localPath?: string; mimeType?: string; fileName?: string }>;
  getContacts(q: string): Promise<Array<{ wxid: string; name: string; type?: string; updatedAt: number }>>;
  getHistory(opts: { chat?: string; limit?: number; account?: string }): Promise<Frame[]>;
  getHealth(): Promise<{ wsUp: boolean; selfWxid?: string; lastMsgTs?: number }>;
}

export function createBridgeClient(opts: BridgeClientOpts): BridgeClient {
  const account = opts.account ?? "default";
  const autoAck = opts.autoAck ?? true;
  const reconnectDelayMs = opts.reconnectDelayMs ?? 3000;
  const log = opts.log;

  const wsBase = opts.url.replace(/\/+$/, "");
  const httpBase = wsBase.replace(/^ws/, "http"); // ws->http, wss->https
  const dispatcher = buildProxyTransport(undefined).dispatcher; // explicit direct

  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function openSocket(): void {
    const url = `${wsBase}/subscribe?token=${encodeURIComponent(opts.token)}&account=${encodeURIComponent(account)}`;
    const socket = new WebSocket(url);
    ws = socket;

    socket.on("message", (data: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return; // ignore malformed
      }
      if (parsed === null || typeof parsed !== "object") return;
      const obj = parsed as Record<string, unknown>;
      if (obj.type === "ready") {
        opts.onReady?.(typeof obj.selfWxid === "string" ? obj.selfWxid : "");
        return;
      }
      if (obj.type === "message") {
        const frame = parsed as Frame;
        try {
          opts.onMessage(frame);
        } finally {
          if (autoAck && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "ack", id: frame.id }));
          }
        }
      }
    });

    socket.on("error", (err) => log?.error?.("bridge-client WS error:", err));

    socket.on("close", () => {
      if (closed) return;
      opts.onDisconnect?.();
      log?.warn?.(`bridge-client WS closed; reconnecting in ${reconnectDelayMs}ms`);
      reconnectTimer = setTimeout(openSocket, reconnectDelayMs);
    });
  }

  async function getJson(path: string): Promise<unknown> {
    try {
      const res = await undiciFetch(`${httpBase}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${opts.token}` },
        dispatcher,
      });
      if (!res.ok) return undefined;
      return await res.json();
    } catch (err) {
      log?.error?.(`bridge-client GET ${path} failed:`, err);
      return undefined;
    }
  }

  async function postJson(path: string, body: unknown): Promise<{ ok: boolean; [k: string]: unknown }> {
    try {
      const res = await undiciFetch(`${httpBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
        body: JSON.stringify(body),
        dispatcher,
      });
      if (!res.ok) return { ok: false };
      return (await res.json()) as { ok: boolean };
    } catch (err) {
      log?.error?.(`bridge-client POST ${path} failed:`, err);
      return { ok: false };
    }
  }

  return {
    connect() {
      closed = false;
      openSocket();
    },
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
      ws = null;
    },
    async send(req) {
      const body: SendRequest = { to: req.to, text: req.text };
      if (req.replyTo !== undefined) body.replyTo = req.replyTo;
      // Default to this connection's configured account (mirrors fetchMedia /
      // getHistory): the per-account bridge knows its account even when the
      // caller omits it. Without this, a multi-instance middleware can't route
      // the reply and drops it with "no instance for account=undefined".
      body.account = req.account ?? account;
      const r = await postJson("/send", body);
      return { ok: r.ok, msgId: typeof r.msgId === "string" ? r.msgId : undefined };
    },
    async forceSync(acct) {
      const r = await postJson("/forceSync", acct ? { account: acct } : {});
      return {
        ok: r.ok,
        messages: typeof r.messages === "number" ? r.messages : undefined,
        hasMore: typeof r.hasMore === "boolean" ? r.hasMore : undefined,
      };
    },
    async fetchMedia(id, acct) {
      const r = await postJson("/media", { id, account: acct ?? account });
      return {
        ok: r.ok,
        localPath: typeof r.localPath === "string" ? r.localPath : undefined,
        mimeType: typeof r.mimeType === "string" ? r.mimeType : undefined,
        fileName: typeof r.fileName === "string" ? r.fileName : undefined,
      };
    },
    async getContacts(q) {
      const r = await getJson(`/contacts?q=${encodeURIComponent(q)}&account=${encodeURIComponent(account)}`);
      return Array.isArray(r) ? (r as Array<{ wxid: string; name: string; type?: string; updatedAt: number }>) : [];
    },
    async getHistory(o) {
      const params = new URLSearchParams({ account: o.account ?? account });
      if (o.chat) params.set("chat", o.chat);
      if (o.limit !== undefined && o.limit > 0) params.set("limit", String(o.limit));
      const r = await getJson(`/history?${params.toString()}`);
      return Array.isArray(r) ? (r as Frame[]) : [];
    },
    async getHealth() {
      const r = await getJson(`/healthz`);
      const obj = (r ?? {}) as Record<string, unknown>;
      return {
        wsUp: obj.wsUp === true,
        selfWxid: typeof obj.selfWxid === "string" ? obj.selfWxid : undefined,
        lastMsgTs: typeof obj.lastMsgTs === "number" ? obj.lastMsgTs : undefined,
      };
    },
  };
}
