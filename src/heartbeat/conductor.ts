import { SmartHeartbeat } from "./smart-heartbeat.js";
import type { HeartbeatStore } from "./store.js";
import { freshNetInfo } from "./types.js";
import type { Logger } from "../shared/logger.js";

export interface HeartbeatResult {
  success: boolean;
  failOfTimeout: boolean;
  /** Round-trip latency of the heartbeat request (ms). Observability only. */
  latencyMs?: number;
  /** Server-returned Selector. Surfaced for LOGGING ONLY — never branched on
   *  (acting on it would trigger a Sync = ban risk; see CLAUDE.md heartbeat rules). */
  selector?: number;
}
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
    let firstBeatLogged = false;
    // Rolling-hour rate cap: tracks beats within the current 1-hour window.
    let windowStart = this.deps.clock.now();
    let beatsInWindow = 0;
    let failsInWindow = 0;

    while (!signal.aborted) {
      // Roll the window if an hour has passed. Emit a steady-state liveness
      // summary at INFO (the per-beat lines are debug-only) so a quiet run still
      // shows the heartbeat is alive once an hour, honoring "info stays quiet".
      if (this.deps.clock.now() - windowStart >= 3_600_000) {
        if (beatsInWindow > 0) {
          const net = this.sh.getNetInfo();
          this.deps.log.info(
            `[hb] alive: ${beatsInWindow} beats/1h cur=${Math.round(net.curHeart / 1000)}s ` +
              `${net.isStable ? "stable" : "probing"} ${failsInWindow} fails`,
          );
        }
        windowStart = this.deps.clock.now();
        beatsInWindow = 0;
        failsInWindow = 0;
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

      const active = this.isActive();
      this.sh.setActive(active);
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
      const net = this.sh.getNetInfo();
      await this.deps.store.save(authcode, net);
      // Count this beat (both success and failure) toward the rolling-hour cap.
      beatsInWindow++;
      if (!res.success) failsInWindow++;

      // Per-beat context — the adaptive interval, the ACTUAL jittered sleep, the
      // active/idle decision, learning progress (succ/stable), rolling-hour cap
      // usage, and (log-only) the read-but-ignored Selector + round-trip latency.
      const ctx =
        `cur=${Math.round(interval / 1000)}s slept=${Math.round(sleepMs / 1000)}s ` +
        `${active ? "active" : "idle"} succ=${net.succHeartCount} ` +
        `${net.isStable ? "stable" : "probing"} beats=${beatsInWindow}/${this.opts.maxPerHour}` +
        (res.selector !== undefined ? ` sel=${res.selector}` : "") +
        (res.latencyMs !== undefined ? ` rtt=${res.latencyMs}ms` : "");

      if (res.success) {
        fails = 0;
        // First successful beat → INFO once, so a fresh start shows liveness
        // within minutes instead of waiting an hour for the rolling summary.
        if (!firstBeatLogged) {
          firstBeatLogged = true;
          this.deps.log.info(`[hb] first beat ok ${ctx}`);
        } else {
          this.deps.log.debug(`[hb] beat ok ${ctx}`);
        }
      } else if (++fails >= this.opts.maxConsecutiveFailures) {
        this.deps.log.error(
          `[hb] ${fails} consecutive heartbeat failures — backing off (no tight retry) ${ctx}`,
        );
        // Stop this cycle. Mars already shrinks the interval adaptively;
        // we must not tight-retry here.
        break;
      } else {
        this.deps.log.warn(`[hb] heartbeat failed (${fails}/${this.opts.maxConsecutiveFailures}) ${ctx}`);
      }
    }
  }
}
