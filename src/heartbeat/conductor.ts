import { SmartHeartbeat } from "./smart-heartbeat.js";
import type { HeartbeatStore } from "./store.js";
import { freshNetInfo } from "./types.js";
import type { Logger } from "../shared/logger.js";

export interface HeartbeatResult { success: boolean; failOfTimeout: boolean; }
export interface HeartbeatClient { sendHeartbeat(): Promise<HeartbeatResult>; }

export interface Clock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface ConductorOptions {
  authcode: string;
  netDetail: string;
  jitterPct: number;
  hardFloorMs: number;
  maxPerHour: number;
  maxConsecutiveFailures: number;
}

export interface ConductorDeps {
  client: HeartbeatClient;
  store: HeartbeatStore;
  clock: Clock;
  log: Logger;
  getLastActivityMs?: () => number | null;
  rng?: () => number;
}

// Not yet user-configurable: activity wiring (activeWindowMs / onlineCheckIntervalMs) is
// deferred to v1. When that lands, this will move into ConductorOptions.
const ACTIVE_WINDOW_MS = 120_000;

export class HeartbeatConductor {
  private readonly ac = new AbortController();
  private sh!: SmartHeartbeat;
  private rng: () => number;

  constructor(private opts: ConductorOptions, private deps: ConductorDeps) {
    this.rng = deps.rng ?? Math.random;
  }

  /** Jitter the interval by ±jitterPct, then enforce the hard floor.
   *  Floor is applied AFTER jitter so it always wins over downward jitter. */
  computeSleep(intervalMs: number): number {
    const j = 1 + (this.rng() * 2 - 1) * this.opts.jitterPct;
    return Math.max(this.opts.hardFloorMs, Math.round(intervalMs * j));
  }

  private isActive(): boolean {
    const last = this.deps.getLastActivityMs?.() ?? null;
    // v1: no activity wiring → always idle (safe; keeps the longer adaptive intervals)
    if (last === null) return false;
    return this.deps.clock.now() - last < ACTIVE_WINDOW_MS;
  }

  stop(): void { this.ac.abort(); }

  async start(): Promise<void> {
    const { authcode, netDetail } = this.opts;
    const signal = this.ac.signal;
    const loaded = (await this.deps.store.load(authcode, netDetail)) ?? freshNetInfo(netDetail);
    this.sh = new SmartHeartbeat(loaded, () => Math.floor(this.deps.clock.now() / 1000));

    let fails = 0;
    // Rolling-hour rate cap: tracks beats within the current 1-hour window.
    let windowStart = this.deps.clock.now();
    let beatsInWindow = 0;

    while (!signal.aborted) {
      // Roll the window if an hour has passed.
      if (this.deps.clock.now() - windowStart >= 3_600_000) {
        windowStart = this.deps.clock.now();
        beatsInWindow = 0;
      }

      // Backstop: if the cap is exhausted, sleep until the window rolls.
      if (beatsInWindow >= this.opts.maxPerHour) {
        const msUntilRoll = windowStart + 3_600_000 - this.deps.clock.now();
        try {
          await this.deps.clock.sleep(msUntilRoll, signal);
        } catch {
          break;
        }
        // After waking, the top of the loop will roll the window.
        continue;
      }

      this.sh.setActive(this.isActive());
      const interval = this.sh.getNextHeartbeatInterval();
      const sleepMs = this.computeSleep(interval);

      try {
        await this.deps.clock.sleep(sleepMs, signal);
      } catch {
        // AbortSignal triggered — exit cleanly
        break;
      }

      if (signal.aborted) break;

      this.sh.onHeartbeatStart();
      const res = await this.deps.client.sendHeartbeat();
      this.sh.onHeartResult(res.success, res.failOfTimeout);
      await this.deps.store.save(authcode, this.sh.getNetInfo());
      // Count this beat (both success and failure) toward the rolling-hour cap.
      beatsInWindow++;

      if (res.success) {
        fails = 0;
        this.deps.log.debug(`[hb] beat ok, next≈${interval}ms`);
      } else if (++fails >= this.opts.maxConsecutiveFailures) {
        this.deps.log.error(
          `[hb] ${fails} consecutive heartbeat failures — backing off (no tight retry)`,
        );
        // Stop this cycle. Mars already shrinks the interval adaptively;
        // we must not tight-retry here.
        break;
      } else {
        this.deps.log.warn(`[hb] heartbeat failed (${fails}/${this.opts.maxConsecutiveFailures})`);
      }
    }
  }
}
