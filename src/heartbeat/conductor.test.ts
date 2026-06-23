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

function fakeStore(initial = freshNetInfo("test")) {
  return {
    loaded: initial,
    saved: [] as any[],
    async load() { return this.loaded; },
    async save(_ac: string, info: any) { this.saved.push(structuredClone(info)); },
    async close() {},
  };
}

/** A clock whose sleep resolves immediately but records the requested ms. */
function fakeClock() {
  let t = 0;
  return {
    sleeps: [] as number[],
    now() { return t; },
    async sleep(ms: number) { this.sleeps.push(ms); t += ms; },
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
  const deps = baseDeps(() => ({ success: true, failOfTimeout: false }));
  deps.store = store as any;
  const c = new HeartbeatConductor(
    { authcode: "AC", netDetail: "test", jitterPct: 0, hardFloorMs: 60000, maxPerHour: 5, maxConsecutiveFailures: 99 },
    deps,
  );
  await c.start();
  assert.ok(store.saved.length > 0);
});
