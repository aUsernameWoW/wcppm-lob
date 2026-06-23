import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHeartbeatConfig, RealClock } from "./runtime.js";

test("resolveHeartbeatConfig defaults are safe (disabled, db15, floor 60s)", () => {
  const c = resolveHeartbeatConfig(undefined);
  assert.equal(c.enabled, false);
  assert.equal(c.redisDb, 15);
  assert.equal(c.hardFloorMs, 60000);
  assert.equal(c.maxPerHour, 30);
  assert.equal(c.jitterPct, 0.07);
  assert.equal(c.maxConsecutiveFailures, 4);
});

test("resolveHeartbeatConfig honours overrides", () => {
  const c = resolveHeartbeatConfig({ enabled: true, redisUrl: "redis://h:6379", jitterPct: 0.1 });
  assert.equal(c.enabled, true);
  assert.equal(c.redisUrl, "redis://h:6379");
  assert.equal(c.jitterPct, 0.1);
});

test("RealClock.sleep rejects on abort", async () => {
  const clock = new RealClock();
  const ac = new AbortController();
  const p = clock.sleep(10000, ac.signal);
  ac.abort();
  await assert.rejects(p);
});
