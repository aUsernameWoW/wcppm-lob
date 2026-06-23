import Redis from "ioredis";
import type { NetHeartbeatInfo } from "./types.js";

/** The minimal ioredis surface we use — lets tests inject a fake. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

/**
 * Heartbeat persistence contract.
 *
 * Key derivation: entries are keyed by (authcode, netDetail).
 * - save() derives the key from info.netDetail
 * - load(authcode, netDetail) must pass the same netDetail as the saved info,
 *   otherwise load will return null (the entry exists but under a different key).
 */
export interface HeartbeatStore {
  load(authcode: string, netDetail: string): Promise<NetHeartbeatInfo | null>;
  save(authcode: string, info: NetHeartbeatInfo): Promise<void>;
  close(): Promise<void>;
}

export function netKey(prefix: string, authcode: string, netDetail: string): string {
  return `${prefix}${authcode}:${netDetail}`;
}

export class RedisHeartbeatStore implements HeartbeatStore {
  private readonly prefix: string;
  private readonly redis: RedisLike;

  constructor(opts: { url: string; db: number; prefix?: string }, redis?: RedisLike) {
    this.prefix = opts.prefix ?? "hbconductor:";
    this.redis = redis ?? new Redis(opts.url, { db: opts.db });
  }

  async load(authcode: string, netDetail: string): Promise<NetHeartbeatInfo | null> {
    const raw = await this.redis.get(netKey(this.prefix, authcode, netDetail));
    return raw ? (JSON.parse(raw) as NetHeartbeatInfo) : null;
  }

  async save(authcode: string, info: NetHeartbeatInfo): Promise<void> {
    await this.redis.set(netKey(this.prefix, authcode, info.netDetail), JSON.stringify(info));
  }

  async close(): Promise<void> { await this.redis.quit(); }
}
