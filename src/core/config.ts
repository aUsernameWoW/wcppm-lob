/**
 * config.ts — the middleware's own configuration (separate from openclaw.json).
 *
 * resolveConfig() applies defaults to a raw config object (typically read from
 * ~/.config/wcppm/config.json) and splits it into the WeChat-client config
 * (passed to WcppClient) and the downstream-bridge config (server + db).
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { WcppConfig, ImageRetryConfig } from "./client.js";
import { DEFAULT_IMAGE_RETRY } from "./client.js";
import { resolveHeartbeatConfig } from "../heartbeat/runtime.js";
import type { HeartbeatConfig } from "../heartbeat/runtime.js";

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
  /** Randomized CDN image-download retry policy (all fields optional; see ImageRetryConfig). */
  imageRetry?: Partial<ImageRetryConfig>;
  // Downstream bridge
  account?: string;
  bridgeToken?: string;
  bridgeHost?: string;
  bridgePort?: number;
  dbPath?: string;
  ageWindowSeconds?: number;
  pruneIntervalMs?: number;
  /**
   * Directory for lazily-downloaded inbound media. Must be readable by the
   * subscriber and — for the OpenClaw adapter — under one of OpenClaw's allowed
   * media roots (e.g. a subdir of /tmp/openclaw or <stateDir>/media), else the
   * agent's image tool rejects the path. Default: <tmp>/wcppm-lob-media.
   */
  mediaDir?: string;
  // Heartbeat conductor (middleware-only, not in openclaw.plugin.json schema)
  heartbeat?: Partial<HeartbeatConfig>;
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
  mediaDir: string;
  heartbeat: HeartbeatConfig;
}

/** Apply defaults to the (optional) imageRetry block and sanity-check the bounds. */
export function resolveImageRetryConfig(raw?: Partial<ImageRetryConfig>): ImageRetryConfig {
  const cfg: ImageRetryConfig = {
    minAttempts: raw?.minAttempts ?? DEFAULT_IMAGE_RETRY.minAttempts,
    maxAttempts: raw?.maxAttempts ?? DEFAULT_IMAGE_RETRY.maxAttempts,
    baseDelayMs: raw?.baseDelayMs ?? DEFAULT_IMAGE_RETRY.baseDelayMs,
    jitterPct: raw?.jitterPct ?? DEFAULT_IMAGE_RETRY.jitterPct,
    randomSeed: raw?.randomSeed ?? DEFAULT_IMAGE_RETRY.randomSeed,
  };
  if (cfg.minAttempts < 1) {
    throw new Error("config: imageRetry.minAttempts must be >= 1 (the first try always runs)");
  }
  if (cfg.maxAttempts < cfg.minAttempts) {
    throw new Error("config: imageRetry.maxAttempts must be >= minAttempts");
  }
  if (cfg.baseDelayMs < 0 || cfg.jitterPct < 0) {
    throw new Error("config: imageRetry.baseDelayMs and jitterPct must be >= 0");
  }
  return cfg;
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
    imageRetry: resolveImageRetryConfig(raw.imageRetry),
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
    mediaDir: raw.mediaDir || join(tmpdir(), "wcppm-lob-media"),
    heartbeat: resolveHeartbeatConfig(raw.heartbeat),
  };
}
