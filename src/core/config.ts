/**
 * config.ts — the middleware's own configuration (separate from openclaw.json).
 *
 * resolveConfig() applies defaults to a raw config object (typically read from
 * ~/.config/wcppm/config.json) and splits it into the WeChat-client config
 * (passed to WcppClient) and the downstream-bridge config (server + db).
 */
import { homedir } from "node:os";
import { join } from "node:path";

import type { WcppConfig } from "./client.js";

/** Loose shape of the on-disk config file. */
export interface RawConfig {
  // WeChat client (passed through to WcppConfig)
  host?: string;
  port?: number;
  authcode?: string;
  wxid?: string;
  proxy?: string;
  wsUrl?: string;
  webhookEnabled?: boolean;
  webhookHost?: string;
  webhookPort?: number;
  webhookPath?: string;
  webhookSecret?: string;
  webhookUrl?: string;
  webhookDebug?: boolean;
  webhookSilentDropUnsigned?: boolean;
  readOnly?: boolean;
  allowMsgTypes?: number[];
  passRevokemsg?: boolean;
  maxMessageAge?: number;
  // Downstream bridge
  account?: string;
  bridgeToken?: string;
  bridgeHost?: string;
  bridgePort?: number;
  dbPath?: string;
  ageWindowSeconds?: number;
  pruneIntervalMs?: number;
}

export interface MiddlewareConfig {
  wcpp: WcppConfig;
  account: string;
  bridgeToken: string;
  bridgeHost: string;
  bridgePort: number;
  dbPath: string;
  ageWindowSeconds: number;
  pruneIntervalMs: number;
}

export function resolveConfig(raw: RawConfig): MiddlewareConfig {
  if (!raw.bridgeToken) {
    throw new Error("config: bridgeToken is required (it is the bearer token guarding the downstream WS/HTTP interface)");
  }

  const wcpp: WcppConfig = {
    host: raw.host ?? "",
    port: raw.port ?? 8062,
    authcode: raw.authcode,
    wxid: raw.wxid,
    proxy: raw.proxy,
    wsUrl: raw.wsUrl,
    webhookEnabled: raw.webhookEnabled,
    webhookHost: raw.webhookHost,
    webhookPort: raw.webhookPort,
    webhookPath: raw.webhookPath,
    webhookSecret: raw.webhookSecret,
    webhookUrl: raw.webhookUrl,
    webhookDebug: raw.webhookDebug,
    webhookSilentDropUnsigned: raw.webhookSilentDropUnsigned,
    readOnly: raw.readOnly,
    allowMsgTypes: raw.allowMsgTypes,
    passRevokemsg: raw.passRevokemsg,
    maxMessageAge: raw.maxMessageAge,
  };

  return {
    wcpp,
    account: raw.account || "default",
    bridgeToken: raw.bridgeToken,
    bridgeHost: raw.bridgeHost || "127.0.0.1",
    bridgePort: raw.bridgePort ?? 8077,
    dbPath: raw.dbPath || join(homedir(), ".local", "share", "wcppm", "state.db"),
    ageWindowSeconds: raw.ageWindowSeconds ?? 600,
    pruneIntervalMs: raw.pruneIntervalMs ?? 600_000,
  };
}
