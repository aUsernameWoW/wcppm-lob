/**
 * Tests for the outbound humanizing pacer. Pure helpers are checked directly;
 * the queue runner is driven with an injected clock + instant-but-clock-advancing
 * sleep so delays are deterministic and no real timers run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createOutboundPacer,
  computeFirstReplyDelay,
  inQuietHours,
  minutesOfDayInTz,
  DEFAULT_OUTBOUND_PACER,
  type OutboundPacerConfig,
  type PacerSendRequest,
} from "./outbound-pacer.js";

function cfg(overrides: Partial<OutboundPacerConfig> = {}): OutboundPacerConfig {
  return { ...DEFAULT_OUTBOUND_PACER, enabled: true, ...overrides };
}

/** A fake clock + sleep that advances the clock by the slept amount instantly. */
function fakeTime() {
  let clock = 1_000_000;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    set: (v: number) => {
      clock = v;
    },
  };
}

/** Let the (microtask-only) runner drain. */
const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("computeFirstReplyDelay scales with length and caps", () => {
  const c = cfg({ firstReplyBaseMs: 1000, firstReplyPerCharMs: 10, firstReplyMaxMs: 4000, jitterPct: 0 });
  assert.equal(computeFirstReplyDelay(0, c, 0.5), 1000); // base only
  assert.equal(computeFirstReplyDelay(100, c, 0.5), 2000); // 1000 + 10*100
  assert.equal(computeFirstReplyDelay(10_000, c, 0.5), 4000); // capped
});

test("computeFirstReplyDelay applies symmetric jitter", () => {
  const c = cfg({ firstReplyBaseMs: 1000, firstReplyPerCharMs: 0, firstReplyMaxMs: 9999, jitterPct: 0.3 });
  assert.equal(computeFirstReplyDelay(0, c, 0), 700); // rand=0 → 1 - 0.3
  assert.equal(computeFirstReplyDelay(0, c, 1), 1300); // rand≈1 → 1 + 0.3
});

test("inQuietHours handles a midnight-wrapping range", () => {
  const q = { enabled: true, timezone: "Asia/Shanghai", ranges: ["23:30-07:30"], delayMultiplier: 4, ceilingPerMinute: 2 };
  // Pick epochs by computing minutes-of-day in the same tz to stay tz-data-agnostic.
  const atShanghai = (h: number, m: number): number => {
    // 2026-01-01 00:00 UTC; Shanghai is UTC+8, so add (h-8) hours + m minutes.
    const baseUtc = Date.UTC(2026, 0, 1, 0, 0, 0);
    return baseUtc + ((h - 8) * 60 + m) * 60_000;
  };
  assert.equal(minutesOfDayInTz(atShanghai(2, 0), "Asia/Shanghai"), 120);
  assert.equal(inQuietHours(atShanghai(2, 0), q), true); // 02:00 → inside
  assert.equal(inQuietHours(atShanghai(23, 45), q), true); // 23:45 → inside (wrap)
  assert.equal(inQuietHours(atShanghai(12, 0), q), false); // noon → outside
  assert.equal(inQuietHours(atShanghai(7, 30), q), false); // boundary end exclusive
});

test("inQuietHours is off when disabled", () => {
  const q = { enabled: false, timezone: "Asia/Shanghai", ranges: ["00:00-23:59"], delayMultiplier: 4, ceilingPerMinute: 2 };
  assert.equal(inQuietHours(Date.now(), q), false);
});

// ---------------------------------------------------------------------------
// Pass-through (kill-switch)
// ---------------------------------------------------------------------------

test("disabled pacer is a transparent pass-through", async () => {
  const calls: PacerSendRequest[] = [];
  const real = async (req: PacerSendRequest) => {
    calls.push(req);
    return { ok: true, msgId: "m1" };
  };
  const pacer = createOutboundPacer(real, cfg({ enabled: false }));
  const r = await pacer.send({ to: "u1", text: "hi" });
  assert.deepEqual(r, { ok: true, msgId: "m1" }); // the REAL result, synchronously
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Enqueue behaviour
// ---------------------------------------------------------------------------

test("first send is fresh (first-reply delay), back-to-back is min-gap", async () => {
  const t = fakeTime();
  const slept: number[] = [];
  const sent: string[] = [];
  const real = async (req: PacerSendRequest) => {
    sent.push(req.text ?? "");
    return { ok: true };
  };
  const c = cfg({
    firstReplyBaseMs: 2000,
    firstReplyPerCharMs: 0,
    jitterPct: 0,
    minGapMs: 1000,
    idleResetMs: 8000,
    hardFloorMs: 100,
    quietHours: { ...DEFAULT_OUTBOUND_PACER.quietHours, enabled: false },
  });
  const sleep = async (ms: number) => {
    slept.push(ms);
    await t.sleep(ms);
  };
  const pacer = createOutboundPacer(real, c, { now: t.now, sleep });

  // Ack is immediate and means "queued", not delivered.
  const ack = await pacer.send({ to: "u1", text: "one" });
  assert.deepEqual(ack, { ok: true, msgId: undefined });
  await pacer.send({ to: "u1", text: "two" });
  await flush();

  assert.deepEqual(sent, ["one", "two"]); // FIFO order preserved
  assert.equal(slept[0], 2000); // first = fresh → first-reply delay
  assert.equal(slept[1], 1000); // second = continuation → min-gap
});

test("a long idle gap makes the next send fresh again", async () => {
  const t = fakeTime();
  const slept: number[] = [];
  const real = async () => ({ ok: true });
  const c = cfg({
    firstReplyBaseMs: 2000,
    firstReplyPerCharMs: 0,
    jitterPct: 0,
    minGapMs: 1000,
    idleResetMs: 8000,
    quietHours: { ...DEFAULT_OUTBOUND_PACER.quietHours, enabled: false },
  });
  const sleep = async (ms: number) => {
    slept.push(ms);
    await t.sleep(ms);
  };
  const pacer = createOutboundPacer(real, c, { now: t.now, sleep });

  await pacer.send({ to: "u1", text: "a" });
  await flush();
  t.advance(20_000); // conversation goes idle
  await pacer.send({ to: "u1", text: "b" });
  await flush();

  assert.equal(slept[0], 2000);
  assert.equal(slept[1], 2000); // fresh again, not min-gap
});

test("queue-depth cap drops and warns instead of growing unbounded", async () => {
  const t = fakeTime();
  const warns: string[] = [];
  // A sleep that never resolves keeps the runner parked on item 1 so the queue fills.
  const block = new Promise<void>(() => {});
  const real = async () => ({ ok: true });
  const pacer = createOutboundPacer(real, cfg({ maxQueueDepth: 3 }), {
    now: t.now,
    sleep: () => block,
    log: { warn: (m) => warns.push(m), debug: () => {} },
  });

  const acks: { ok: boolean; msgId?: string }[] = [];
  for (let i = 0; i < 5; i++) acks.push(await pacer.send({ to: "u1", text: String(i) }));
  // item0 is in-flight (parked in sleep); queue holds at most maxQueueDepth.
  const dropped = acks.filter((a) => a.ok === false).length;
  assert.ok(dropped >= 1, "expected at least one drop past the cap");
  assert.ok(warns.some((w) => w.includes("DROP")));
  pacer.stop();
});

test("stop halts the runner", async () => {
  const t = fakeTime();
  const sent: string[] = [];
  const real = async (req: PacerSendRequest) => {
    sent.push(req.text ?? "");
    return { ok: true };
  };
  const c = cfg({ firstReplyBaseMs: 1000, jitterPct: 0, quietHours: { ...DEFAULT_OUTBOUND_PACER.quietHours, enabled: false } });
  const pacer = createOutboundPacer(real, c, { now: t.now, sleep: t.sleep });
  pacer.stop();
  const r = await pacer.send({ to: "u1", text: "x" });
  assert.equal(r.ok, false); // refused after stop
  await flush();
  assert.equal(sent.length, 0);
});
