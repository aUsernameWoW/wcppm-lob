import { test } from "node:test";
import assert from "node:assert/strict";
import { HeartbeatConductor, type ConductorDeps, type HeartbeatResult } from "./conductor.js";
import { freshNetInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers (each defined exactly once)
// ---------------------------------------------------------------------------

function silentLog() {
  return { info() {}, error() {}, warn() {}, debug() {} };
}

/** A logger that records every line with its level, for asserting log output. */
function recordingLog() {
  const lines: { level: string; msg: string }[] = [];
  const push = (level: string) => (...a: any[]) => lines.push({ level, msg: a.join(" ") });
  return { lines, info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug") };
}

function fakeStore(initial = freshNetInfo("test")) {
  return {
    loaded: initial,
    saved: [] as any[],
    async load() { return this.loaded; },
    async save(_ac: string, info: any) { this.saved.push(structuredClone(info)); },
    async close() {},
  };
}

/** A clock whose sleep resolves immediately, advancing internal time by ms. */
function fakeClock() {
  let t = 0;
  return {
    sleeps: [] as number[],
    now() { return t; },
    async sleep(ms: number, _signal?: AbortSignal) { this.sleeps.push(ms); t += ms; },
  };
}

function baseDeps(
  responder: () => HeartbeatResult,
  clock = fakeClock(),
): ConductorDeps {
  return {
    client: { async sendHeartbeat() { return responder(); } },
    store: fakeStore() as any,
    clock: clock as any,
    log: silentLog(),
    rng: () => 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("computeSleep applies jitter then clamps to hardFloor", () => {
  const deps = baseDeps(() => ({ success: true, failOfTimeout: false }));
  const c = new HeartbeatConductor(
    { authcode: "AC", netDetail: "test", jitterPct: 0.07, hardFloorMs: 60000, maxPerHour: 30, maxConsecutiveFailures: 4 },
    deps,
  );
  // rng=0 → maximum downward jitter (factor = 1 + (0*2-1)*0.07 = 0.93); floor must win when it would dip below 60000.
  assert.ok(c.computeSleep(60000) >= 60000);
  // a large interval stays jittered within ±7%.
  const v = c.computeSleep(580000);
  assert.ok(v >= 580000 * 0.93 && v <= 580000 * 1.07);
});

test("stops after maxConsecutiveFailures without tight-retrying", async () => {
  const clock = fakeClock();
  let calls = 0;
  const deps = baseDeps(() => { calls++; return { success: false, failOfTimeout: true }; }, clock);
  const c = new HeartbeatConductor(
    { authcode: "AC", netDetail: "test", jitterPct: 0, hardFloorMs: 60000, maxPerHour: 9999, maxConsecutiveFailures: 4 },
    deps,
  );
  await c.start();
  // every sleep is >= hardFloor; never a zero-ms tight retry.
  assert.ok(clock.sleeps.every((s) => s >= 60000));
  assert.equal(calls, 4);
});

test("feeds results into SmartHeartbeat and persists", async () => {
  const store = fakeStore();
  const clock = fakeClock();
  let beats = 0;
  let conductor!: HeartbeatConductor;
  const deps: ConductorDeps = {
    client: {
      async sendHeartbeat() {
        beats++;
        if (beats >= 3) conductor.stop();
        return { success: true, failOfTimeout: false };
      },
    },
    store: store as any,
    clock: clock as any,
    log: silentLog(),
    rng: () => 0,
  };
  conductor = new HeartbeatConductor(
    { authcode: "AC", netDetail: "test", jitterPct: 0, hardFloorMs: 60000, maxPerHour: 9999, maxConsecutiveFailures: 99 },
    deps,
  );
  await conductor.start();
  assert.ok(store.saved.length > 0);
});

// ---------------------------------------------------------------------------
// Regression test for Finding 1: maxPerHour is a rolling-hour cap, not a
// lifetime budget. Drive the loop past 2 hours of fake-clock time and assert
// that total beats exceed maxPerHour.
// ---------------------------------------------------------------------------
test("logs first beat at INFO with rich context, then per-beat at DEBUG", async () => {
  const clock = fakeClock();
  const log = recordingLog();
  let beats = 0;
  let conductor!: HeartbeatConductor;
  const deps: ConductorDeps = {
    client: {
      async sendHeartbeat() {
        beats++;
        if (beats >= 3) conductor.stop();
        return { success: true, failOfTimeout: false, selector: 0, latencyMs: 12 };
      },
    },
    store: fakeStore() as any,
    clock: clock as any,
    log,
    rng: () => 0,
  };
  conductor = new HeartbeatConductor(
    { authcode: "AC", netDetail: "test", jitterPct: 0, hardFloorMs: 60000, maxPerHour: 9999, maxConsecutiveFailures: 99 },
    deps,
  );
  await conductor.start();

  const first = log.lines.find((l) => l.msg.includes("first beat ok"));
  assert.ok(first, "expected a first-beat line");
  assert.equal(first!.level, "info", "first beat must be INFO");
  // Rich context fields present and the round-trip latency surfaced.
  assert.match(first!.msg, /cur=\d+s slept=\d+s (active|idle) succ=\d+ (stable|probing) beats=\d+\/\d+/);
  assert.match(first!.msg, /rtt=12ms/);

  // Subsequent beats are DEBUG, not INFO (steady state stays quiet).
  const debugBeats = log.lines.filter((l) => l.level === "debug" && l.msg.includes("beat ok"));
  assert.ok(debugBeats.length >= 1, "expected per-beat DEBUG lines after the first");
});

test("Selector is logged (sel=) but never triggers any extra action", async () => {
  const clock = fakeClock();
  const log = recordingLog();
  let beats = 0;
  let conductor!: HeartbeatConductor;
  const deps: ConductorDeps = {
    client: {
      async sendHeartbeat() {
        beats++;
        if (beats >= 2) conductor.stop();
        // A non-zero Selector must NOT change behavior (no Sync, no extra calls).
        return { success: true, failOfTimeout: false, selector: 7 };
      },
    },
    store: fakeStore() as any,
    clock: clock as any,
    log,
    rng: () => 0,
  };
  conductor = new HeartbeatConductor(
    { authcode: "AC", netDetail: "test", jitterPct: 0, hardFloorMs: 60000, maxPerHour: 9999, maxConsecutiveFailures: 99 },
    deps,
  );
  await conductor.start();

  assert.ok(log.lines.some((l) => l.msg.includes("sel=7")), "expected Selector to be logged");
  // Conductor exposes only heartbeat — the only client method is sendHeartbeat,
  // and a non-zero Selector did not provoke extra beats (exactly 2 before stop).
  assert.equal(beats, 2);
});

test("emits an hourly INFO liveness summary across a window roll", async () => {
  const clock = fakeClock();
  const log = recordingLog();
  let conductor!: HeartbeatConductor;
  const deps: ConductorDeps = {
    client: {
      async sendHeartbeat() {
        // Run past one full hour of fake-clock time, then stop.
        if (clock.now() >= 3_700_000) conductor.stop();
        return { success: true, failOfTimeout: false };
      },
    },
    store: fakeStore() as any,
    clock: clock as any,
    log,
    rng: () => 0,
  };
  conductor = new HeartbeatConductor(
    { authcode: "AC", netDetail: "test", jitterPct: 0, hardFloorMs: 60000, maxPerHour: 9999, maxConsecutiveFailures: 99 },
    deps,
  );
  await conductor.start();

  const summary = log.lines.find((l) => l.level === "info" && /\[hb\] alive: \d+ beats\/1h/.test(l.msg));
  assert.ok(summary, "expected an hourly INFO liveness summary");
});

test("maxPerHour rolls per hour — beats exceed cap across multiple hours", async () => {
  const maxPerHour = 3;
  // Each fake sleep advances time by hardFloorMs (60 s). With maxPerHour=3 and
  // hardFloor=60 s, one hour fits exactly 60 beats, so the cap kicks in once per
  // hour. We stop once fake-clock time has advanced past 2.1 hours (7_560_000 ms).
  const STOP_AT_MS = 7_560_000; // 2.1 hours
  let totalBeats = 0;
  let conductor!: HeartbeatConductor;

  const clock = fakeClock();

  const deps: ConductorDeps = {
    client: {
      async sendHeartbeat() {
        totalBeats++;
        if (clock.now() >= STOP_AT_MS) conductor.stop();
        return { success: true, failOfTimeout: false };
      },
    },
    store: fakeStore() as any,
    clock: clock as any,
    log: silentLog(),
    rng: () => 0,
  };

  conductor = new HeartbeatConductor(
    {
      authcode: "AC",
      netDetail: "test",
      jitterPct: 0,
      hardFloorMs: 60_000,
      maxPerHour,
      maxConsecutiveFailures: 9999,
    },
    deps,
  );

  await conductor.start();

  // With a rolling-hour cap of 3 beats/hour, across >2 hours we must see more
  // than maxPerHour total beats. If the bug were present (lifetime budget),
  // the loop would exit after exactly 3 beats.
  assert.ok(
    totalBeats > maxPerHour,
    `expected totalBeats (${totalBeats}) > maxPerHour (${maxPerHour}) — cap must roll per hour`,
  );
});
