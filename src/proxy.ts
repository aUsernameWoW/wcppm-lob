import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";
import { ProxyAgent as NodeHttpProxyAgent } from "proxy-agent";
import type { Agent as HttpAgent } from "node:http";

export type ProxyKind = "direct" | "http" | "socks";

export interface ProxyTransport {
  kind: ProxyKind;
  /**
   * undici dispatcher to pass per-request to fetch(). For "direct" this is a
   * plain Agent that **overrides** OpenClaw's process-global EnvHttpProxyAgent —
   * without it a bare fetch() silently inherits the ambient HTTP_PROXY.
   */
  dispatcher: Dispatcher;
  /** http.Agent for the `ws` WebSocket `agent` option; undefined = direct (ws default). */
  wsAgent?: HttpAgent;
}

const SOCKS_SCHEMES = new Set(["socks", "socks5", "socks5h", "socks4", "socks4a"]);

/**
 * Map the channel's `Proxy URL` config to transports for both outbound paths.
 *
 * - empty / unset → explicit **direct** (bypasses the global env proxy)
 * - `http(s)://…`  → CONNECT proxy
 * - `socks(5|4)://…` → SOCKS proxy
 * - anything else → throws (fail fast at startup with a clear message)
 */
export function buildProxyTransport(proxy?: string): ProxyTransport {
  const raw = (proxy ?? "").trim();

  if (!raw) {
    return { kind: "direct", dispatcher: new Agent(), wsAgent: undefined };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `wechatpadpro: invalid Proxy URL "${raw}" (use http(s)://… or socks5://…, or leave empty for a direct connection)`,
    );
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();

  if (scheme === "http" || scheme === "https") {
    return {
      kind: "http",
      dispatcher: new ProxyAgent(raw),
      wsAgent: new NodeHttpProxyAgent({ getProxyForUrl: () => raw }),
    };
  }

  if (SOCKS_SCHEMES.has(scheme)) {
    return {
      kind: "socks",
      dispatcher: socksDispatcher({
        type: scheme.startsWith("socks4") ? 4 : 5,
        host: url.hostname,
        port: url.port ? Number(url.port) : 1080,
        userId: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
      }),
      wsAgent: new NodeHttpProxyAgent({ getProxyForUrl: () => raw }),
    };
  }

  throw new Error(
    `wechatpadpro: unsupported proxy scheme "${scheme}" in Proxy URL (use http(s)://… or socks5://…, or leave empty)`,
  );
}
