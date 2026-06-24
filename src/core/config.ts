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

/**
 * Per-WeChat-instance fields. In a multi-instance config these live inside each
 * `instances[]` entry; in a legacy flat config they sit at the top level and
 * synthesize a single `default` instance. Webhook listener fields are NOT here —
 * the middleware runs ONE shared webhook listener and routes by Wxid (see below).
 */
export interface RawInstanceConfig {
  /** Stable label that identifies this account across the bridge (== subscribe ?account=). */
  account?: string;
  host?: string;
  port?: number;
  authcode?: string;
  /** This account's self-wxid. Used to route shared-webhook frames to this instance. */
  wxid?: string;
  proxy?: string;
  wsUrl?: string;
  readOnly?: boolean;
  allowMsgTypes?: number[];
  passRevokemsg?: boolean;
  maxMessageAge?: number;
  /** Randomized CDN image-download retry policy (all fields optional; see ImageRetryConfig). */
  imageRetry?: Partial<ImageRetryConfig>;
}

/** Loose shape of the on-disk config file. */
export interface RawConfig extends RawInstanceConfig {
  /** Multi-instance form. When present, supersedes the top-level flat instance fields. */
  instances?: RawInstanceConfig[];

  // Shared webhook listener (ONE port for all instances; routed by envelope.Wxid).
  webhookEnabled?: boolean;
  webhookHost?: string;
  webhookPort?: number;
  webhookPath?: string;
  webhookSecret?: string;
  webhookDebug?: boolean;
  webhookSilentDropUnsigned?: boolean;

  // Downstream bridge (single, shared across instances).
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

/** A single resolved WeChat instance: its account label + the client config. */
export interface InstanceConfig {
  account: string;
  wcpp: WcppConfig;
}

/** The shared webhook listener: one port, signature-verified, routed by Wxid. */
export interface WebhookListenerConfig {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
  secret?: string;
  debug: boolean;
  silentDropUnsigned: boolean;
}

export interface MiddlewareConfig {
  instances: InstanceConfig[];
  webhook: WebhookListenerConfig;
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

/**
 * Resolve one raw instance entry into an InstanceConfig. `index` is only used for
 * error messages. The webhook* fields are intentionally NOT threaded here: the
 * shared listener owns the webhook port, so each instance keeps webhookEnabled off.
 */
function resolveInstance(raw: RawInstanceConfig, index: number): InstanceConfig {
  const account = (raw.account || "").trim();
  if (!account) {
    throw new Error(`config: instances[${index}] is missing an "account" label (the stable id used across the bridge)`);
  }
  const wcpp: WcppConfig = {
    host: raw.host ?? "",
    port: raw.port ?? 8062,
    authcode: raw.authcode,
    wxid: raw.wxid,
    proxy: raw.proxy,
    wsUrl: raw.wsUrl,
    // Shared webhook listener owns the port — never start a per-instance one.
    webhookEnabled: false,
    readOnly: raw.readOnly,
    allowMsgTypes: raw.allowMsgTypes,
    passRevokemsg: raw.passRevokemsg,
    maxMessageAge: raw.maxMessageAge,
    imageRetry: resolveImageRetryConfig(raw.imageRetry),
  };
  return { account, wcpp };
}

export function resolveConfig(raw: RawConfig): MiddlewareConfig {
  if (!raw.bridgeToken) {
    throw new Error("config: bridgeToken is required (it is the bearer token guarding the downstream WS/HTTP interface)");
  }

  // Multi-instance form wins; otherwise synthesize a single instance from the flat
  // top-level fields (back-compat with the legacy single-account config), defaulting
  // the account label to "default".
  const rawInstances: RawInstanceConfig[] =
    raw.instances && raw.instances.length > 0 ? raw.instances : [{ ...raw, account: raw.account || "default" }];

  const instances = rawInstances.map(resolveInstance);

  const seen = new Set<string>();
  for (const inst of instances) {
    if (seen.has(inst.account)) {
      throw new Error(`config: duplicate account label "${inst.account}" (each instance needs a unique account)`);
    }
    seen.add(inst.account);
  }

  const webhook: WebhookListenerConfig = {
    enabled: raw.webhookEnabled ?? false,
    host: raw.webhookHost || "127.0.0.1",
    port: raw.webhookPort ?? 8000,
    path: raw.webhookPath || "/webhook",
    secret: raw.webhookSecret,
    debug: raw.webhookDebug ?? false,
    silentDropUnsigned: raw.webhookSilentDropUnsigned ?? false,
  };

  return {
    instances,
    webhook,
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
