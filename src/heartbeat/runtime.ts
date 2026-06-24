import { setTimeout as sleepAsync } from "node:timers/promises";
import { HeartbeatConductor } from "./conductor.js";
import type { Clock } from "./conductor.js";
import { RedisHeartbeatStore } from "./store.js";
import { WcppHeartbeatClient } from "./wcpp-client.js";
import type { Logger } from "../shared/logger.js";

export interface HeartbeatConfig {
  enabled: boolean;
  redisUrl: string;
  redisDb: number;
  jitterPct: number;
  hardFloorMs: number;
  maxPerHour: number;
  maxConsecutiveFailures: number;
}

export function resolveHeartbeatConfig(raw: Partial<HeartbeatConfig> | undefined): HeartbeatConfig {
  return {
    enabled: raw?.enabled ?? false,
    redisUrl: raw?.redisUrl ?? "redis://127.0.0.1:6379",
    redisDb: raw?.redisDb ?? 15,
    jitterPct: raw?.jitterPct ?? 0.07,
    hardFloorMs: raw?.hardFloorMs ?? 60000,
    maxPerHour: raw?.maxPerHour ?? 30,
    maxConsecutiveFailures: raw?.maxConsecutiveFailures ?? 4,
  };
}

export class RealClock implements Clock {
  now(): number { return Date.now(); }
  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    await sleepAsync(ms, undefined, { signal });
  }
}

/**
 * Derive the heartbeat netDetail (the second half of the redis netKey). Namespaced
 * by host:port so two instances that share an authcode (same WCPPM token across
 * servers) still get DISTINCT heartbeat-state keys — otherwise their adaptive
 * interval state would clobber each other in redis.
 */
export function heartbeatNetDetail(wcpp: { host?: string; port: number; proxy?: string }): string {
  return `egress:${wcpp.proxy ? "proxy" : "direct"}@${wcpp.host ?? ""}:${wcpp.port}`;
}

/** Wire and start a conductor; returns a handle, or null if disabled/unconfigured. */
export function startHeartbeatConductor(
  cfg: HeartbeatConfig,
  wcpp: { host?: string; port: number; authcode?: string; proxy?: string },
  log: Logger,
): { stop(): Promise<void> } | null {
  if (!cfg.enabled) { log.debug("[hb] conductor disabled (heartbeat.enabled=false)"); return null; }
  if (!wcpp.host || !wcpp.authcode) { log.error("[hb] cannot start: host/authcode required"); return null; }

  const baseUrl = `http://${wcpp.host}:${wcpp.port}`;
  const store = new RedisHeartbeatStore({ url: cfg.redisUrl, db: cfg.redisDb });
  const client = new WcppHeartbeatClient({ baseUrl, authcode: wcpp.authcode, proxy: wcpp.proxy, log });
  const netDetail = heartbeatNetDetail(wcpp);
  const conductor = new HeartbeatConductor(
    {
      authcode: wcpp.authcode, netDetail,
      jitterPct: cfg.jitterPct, hardFloorMs: cfg.hardFloorMs,
      maxPerHour: cfg.maxPerHour, maxConsecutiveFailures: cfg.maxConsecutiveFailures,
    },
    { client, store, clock: new RealClock(), log },
  );
  log.info(`[hb] starting Mars heartbeat conductor (net=${netDetail}, floor=${cfg.hardFloorMs}ms)`);
  void conductor.start().catch((e) => log.error(`[hb] conductor crashed: ${e?.message ?? e}`));
  return { async stop() { conductor.stop(); await store.close(); } };
}
