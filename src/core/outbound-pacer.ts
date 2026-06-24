/**
 * outbound-pacer.ts — humanizing pacer on the middleware's outbound `/send` path.
 *
 * Goal (风控 camouflage): make the account's outbound timing resemble a real Mac
 * WeChat client instead of an always-instant, 24/7, machine-gun replier. It sits
 * at the single outbound choke point (between the bridge `/send` handler and
 * WcppClient.send*), so it protects EVERY consumer (the OpenClaw adapter, operator
 * forceSync replies, future bots) — not just one adapter's replies.
 *
 * It implements three behaviours, all config-driven and kill-switchable:
 *   A. First-reply delay — a few-second "read + compose" pause before the first
 *      send into an idle conversation (kills the sub-second秒回 bot tell). Scaled
 *      by outbound text length + jitter.
 *   E. Pacing / burst cap — a per-conversation min-gap between back-to-back sends,
 *      PLUS a per-account sliding-window ceiling (sends/min · /hour) that stretches
 *      spacing under load. A per-conversation queue-depth cap is the hard backstop
 *      (drop + loud warn) so the queue can never grow unbounded.
 *   D. Quiet hours — during a configured nightly window, multiply the human delay
 *      and lower the per-minute ceiling (a real human sleeps). It only *slows*; it
 *      does NOT defer-to-morning (that would risk losing queued replies on restart
 *      and surface stale midnight replies at 8am — left as a future mode).
 *
 * Contract (decided 2026-06-24): `send()` ENQUEUES and returns `{ ok:true, queued:true }`
 * IMMEDIATELY; the real send happens later off the queue. So the returned `ok` means
 * "accepted into the pacer", not "delivered" — a true send failure is logged here,
 * not surfaced synchronously to the caller. The queue is in-memory: a restart inside
 * the (seconds-scale) delay window drops those not-yet-sent replies (inbound is still
 * persisted in SQLite, so this is an accepted, bounded loss).
 *
 * When `enabled:false` (the default), `send()` is a transparent pass-through to the
 * real send — identical to the pre-pacer instant behaviour. This is the kill-switch.
 *
 * Scope: one pacer per account/instance. Per-conversation state is keyed by the
 * outbound `to` wxid; the sliding-window ceiling is pacer-wide (= per-account).
 */

import type { OutboundMedia } from "../shared/frame.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Nightly slow-down window. Only active while the pacer itself is enabled. */
export interface QuietHoursConfig {
  enabled: boolean;
  /** IANA timezone the ranges are interpreted in (e.g. "Asia/Shanghai"). */
  timezone: string;
  /** Windows as "HH:MM-HH:MM"; a range may wrap midnight ("23:30-07:30"). */
  ranges: string[];
  /** Multiply the computed human delay by this during quiet hours. */
  delayMultiplier: number;
  /** Lower per-minute send ceiling during quiet hours. */
  ceilingPerMinute: number;
}

export interface OutboundPacerConfig {
  /** Kill-switch. false → transparent pass-through (current instant behaviour). */
  enabled: boolean;

  // A — first-reply ("read + compose") delay, scaled by outbound text length.
  /** Base delay floor for a fresh reply, before the per-char term. */
  firstReplyBaseMs: number;
  /** Added per character of outbound text (longer reply ⇒ longer "typing"). */
  firstReplyPerCharMs: number;
  /** Hard cap on the first-reply delay (keep it "a few seconds"). */
  firstReplyMaxMs: number;
  /** ± fraction of random jitter applied to the human delay. */
  jitterPct: number;

  // E — pacing.
  /** Minimum gap between back-to-back sends in the SAME conversation (continuations). */
  minGapMs: number;
  /** Conversation quiet for this long ⇒ next send is "fresh" (gets the first-reply delay). */
  idleResetMs: number;
  /** No computed delay ever goes below this. */
  hardFloorMs: number;
  /** Per-conversation queue depth beyond which new sends are DROPPED (+warn). */
  maxQueueDepth: number;
  /** Per-account sliding-window ceiling: max sends per rolling minute. */
  ceilingPerMinute: number;
  /** Per-account sliding-window ceiling: max sends per rolling hour. */
  ceilingPerHour: number;

  // D — quiet hours.
  quietHours: QuietHoursConfig;
}

export const DEFAULT_OUTBOUND_PACER: OutboundPacerConfig = {
  enabled: false, // off until verified (mirrors the heartbeat conductor's rollout)
  firstReplyBaseMs: 1200,
  firstReplyPerCharMs: 12,
  firstReplyMaxMs: 5000, // "a few seconds"
  jitterPct: 0.3,
  minGapMs: 1000,
  idleResetMs: 8000,
  hardFloorMs: 500,
  maxQueueDepth: 30,
  ceilingPerMinute: 6, // conservative
  ceilingPerHour: 90, // conservative
  quietHours: {
    enabled: true,
    timezone: "Asia/Shanghai",
    ranges: ["23:30-07:30"],
    delayMultiplier: 4,
    ceilingPerMinute: 2,
  },
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Minutes-since-midnight for `ms` (epoch) in `tz`. */
export function minutesOfDayInTz(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = Number(p.value);
    else if (p.type === "minute") m = Number(p.value);
  }
  if (h === 24) h = 0; // some ICU builds render midnight as 24:00
  return h * 60 + m;
}

/** Parse "HH:MM" → minutes-since-midnight, or null if malformed. */
function parseHm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Is `nowMs` within any of the quiet-hours ranges (handling midnight wrap)? */
export function inQuietHours(nowMs: number, cfg: QuietHoursConfig): boolean {
  if (!cfg.enabled || cfg.ranges.length === 0) return false;
  const cur = minutesOfDayInTz(nowMs, cfg.timezone);
  for (const range of cfg.ranges) {
    const dash = range.indexOf("-");
    if (dash < 0) continue;
    const start = parseHm(range.slice(0, dash));
    const end = parseHm(range.slice(dash + 1));
    if (start === null || end === null) continue;
    if (start <= end) {
      if (cur >= start && cur < end) return true;
    } else {
      // wraps midnight: e.g. 23:30..24:00 ∪ 00:00..07:30
      if (cur >= start || cur < end) return true;
    }
  }
  return false;
}

/**
 * Human "read + compose" delay for a fresh reply: base + perChar·len, capped,
 * then ±jitter. `rand` ∈ [0,1) is injectable for deterministic tests.
 */
export function computeFirstReplyDelay(
  textLen: number,
  cfg: OutboundPacerConfig,
  rand: number,
): number {
  const raw = Math.min(cfg.firstReplyBaseMs + cfg.firstReplyPerCharMs * textLen, cfg.firstReplyMaxMs);
  const jitter = 1 + cfg.jitterPct * (rand * 2 - 1); // [1-jitterPct, 1+jitterPct)
  return Math.round(raw * jitter);
}

// ---------------------------------------------------------------------------
// Pacer
// ---------------------------------------------------------------------------

/** The outbound request shape the pacer forwards (mirrors wiring.SendRequest). */
export interface PacerSendRequest {
  account?: string;
  to: string;
  text?: string;
  replyTo?: string;
  media?: OutboundMedia;
}

export type RealSend = (req: PacerSendRequest) => Promise<{ ok: boolean; msgId?: string }>;

export interface PacerLogger {
  warn: (msg: string) => void;
  debug: (msg: string) => void;
}

export interface PacerDeps {
  /** Injectable clock (ms). Default Date.now. */
  now?: () => number;
  /** Injectable sleep. Default setTimeout-backed. Tests pass an instant/clocked one. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG in [0,1). Default Math.random. */
  random?: () => number;
  log?: PacerLogger;
}

interface ConversationState {
  queue: PacerSendRequest[];
  running: boolean;
  lastReleaseAt: number; // 0 = never released → first send is "fresh"
}

export interface OutboundPacer {
  /** Enqueue (or, when disabled, pass through) an outbound send. */
  send: RealSend;
  /** Stop processing: drains nothing, just halts runners so timers don't linger. */
  stop: () => void;
}

const ONE_MINUTE = 60_000;
const ONE_HOUR = 3_600_000;

/**
 * Build an outbound pacer wrapping `realSend`. One instance per account.
 */
export function createOutboundPacer(
  realSend: RealSend,
  cfg: OutboundPacerConfig,
  deps: PacerDeps = {},
): OutboundPacer {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const log = deps.log;

  // Disabled → transparent pass-through (the kill-switch path).
  if (!cfg.enabled) {
    return { send: realSend, stop: () => {} };
  }

  const conversations = new Map<string, ConversationState>();
  /** Per-account sliding window of recent actual-send timestamps. */
  const sentTimes: number[] = [];
  let stopped = false;

  /** Drop send timestamps older than an hour; return the trimmed array length. */
  function pruneSent(nowMs: number): void {
    while (sentTimes.length > 0 && nowMs - sentTimes[0] > ONE_HOUR) sentTimes.shift();
  }

  /** Extra wait (ms) needed so the per-account ceilings aren't exceeded. */
  function ceilingWaitMs(nowMs: number, quiet: boolean): number {
    pruneSent(nowMs);
    const perMinute = quiet ? cfg.quietHours.ceilingPerMinute : cfg.ceilingPerMinute;
    let wait = 0;
    // per-minute
    const minuteStart = sentTimes.findIndex((t) => nowMs - t < ONE_MINUTE);
    const inMinute = minuteStart < 0 ? 0 : sentTimes.length - minuteStart;
    if (inMinute >= perMinute && minuteStart >= 0) {
      wait = Math.max(wait, ONE_MINUTE - (nowMs - sentTimes[minuteStart]));
    }
    // per-hour
    if (sentTimes.length >= cfg.ceilingPerHour) {
      wait = Math.max(wait, ONE_HOUR - (nowMs - sentTimes[0]));
    }
    return Math.max(0, wait);
  }

  function getConversation(key: string): ConversationState {
    let c = conversations.get(key);
    if (!c) {
      c = { queue: [], running: false, lastReleaseAt: 0 };
      conversations.set(key, c);
    }
    return c;
  }

  async function runConversation(key: string, c: ConversationState): Promise<void> {
    c.running = true;
    try {
      while (c.queue.length > 0 && !stopped) {
        const req = c.queue.shift()!;
        const t0 = now();
        const quiet = inQuietHours(t0, cfg.quietHours);

        // Classify: fresh (idle conversation) gets the first-reply delay;
        // a back-to-back continuation only gets the min-gap.
        const idle = c.lastReleaseAt === 0 || t0 - c.lastReleaseAt > cfg.idleResetMs;
        let delay = idle
          ? computeFirstReplyDelay((req.text ?? "").length, cfg, random())
          : cfg.minGapMs;
        if (quiet) delay = Math.round(delay * cfg.quietHours.delayMultiplier);
        delay = Math.max(delay, cfg.hardFloorMs);
        // Stretch under load so the per-account ceilings hold.
        delay = Math.max(delay, ceilingWaitMs(t0, quiet));

        await sleep(delay);
        if (stopped) break;

        const tSend = now();
        sentTimes.push(tSend);
        c.lastReleaseAt = tSend;
        log?.debug(
          `[pace] release to=${req.to} idle=${idle} delay=${delay}ms quiet=${quiet}` +
            ` qlen=${c.queue.length} win=${sentTimes.length}`,
        );
        try {
          const r = await realSend(req);
          if (!r.ok) log?.warn(`[pace] send to=${req.to} returned not-ok (post-ack)`);
        } catch (err) {
          // Post-ack failure: nothing to surface to the caller — log it.
          log?.warn(`[pace] send to=${req.to} failed (post-ack): ${String(err)}`);
        }
      }
    } finally {
      c.running = false;
      // Drop fully-drained, long-idle conversations so the map can't grow forever.
      if (c.queue.length === 0) conversations.delete(key);
    }
  }

  return {
    send: async (req) => {
      if (stopped) return { ok: false };
      const key = `${req.account ?? "default"}:${req.to}`;
      const c = getConversation(key);
      if (c.queue.length >= cfg.maxQueueDepth) {
        // Hard backstop: never let one conversation's queue grow unbounded.
        log?.warn(
          `[pace] DROP to=${req.to} — queue at cap (${cfg.maxQueueDepth}); outbound is backed up`,
        );
        return { ok: false };
      }
      c.queue.push(req);
      if (!c.running) void runConversation(key, c);
      // Ack immediately: accepted into the pacer, not yet delivered.
      return { ok: true, msgId: undefined };
    },
    stop: () => {
      stopped = true;
      conversations.clear();
    },
  };
}
