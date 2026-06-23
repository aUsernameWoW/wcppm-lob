import { test } from "node:test";
import assert from "node:assert/strict";
import { SmartHeartbeat } from "./smart-heartbeat.js";
import { freshNetInfo } from "./types.js";
import { MIN_HEART_INTERVAL, MAX_HEART_INTERVAL, SUCCESS_STEP } from "./constants.js";

const CEIL = MAX_HEART_INTERVAL - SUCCESS_STEP; // 580000 — the stable ceiling

function make(active = false) {
  const sh = new SmartHeartbeat(freshNetInfo("test"), () => 0);
  sh.setActive(active);
  return sh;
}
/** One real beat: compute interval, "send", deliver a result. */
function beat(sh: SmartHeartbeat, success: boolean, timeout = false) {
  sh.getNextHeartbeatInterval();
  sh.onHeartbeatStart();
  sh.onHeartResult(success, timeout);
}

test("starts at MIN", () => {
  assert.equal(make().getNextHeartbeatInterval(), MIN_HEART_INTERVAL);
});

test("active → always MIN even after many successes", () => {
  const sh = make(true);
  for (let i = 0; i < 300; i++) beat(sh, true);
  assert.equal(sh.getNextHeartbeatInterval(), MIN_HEART_INTERVAL);
});

test("sustained success climbs and saturates at MAX - SuccessStep", () => {
  const sh = make(false);
  for (let i = 0; i < 300; i++) beat(sh, true);
  assert.equal(sh.getNextHeartbeatInterval(), CEIL);
});

test("sustained failure after saturation returns to MIN", () => {
  const sh = make(false);
  for (let i = 0; i < 300; i++) beat(sh, true);
  for (let i = 0; i < 600; i++) beat(sh, false);
  assert.equal(sh.getNextHeartbeatInterval(), MIN_HEART_INTERVAL);
});

test("interval is always within [MIN, MAX - SuccessStep]", () => {
  const sh = make(false);
  const seq = [true, true, true, false, true, true, false, false, true];
  for (let i = 0; i < 50; i++) {
    for (const ok of seq) beat(sh, ok);
    const v = sh.getNextHeartbeatInterval();
    assert.ok(v >= MIN_HEART_INTERVAL && v <= CEIL, `interval ${v} out of bounds`);
  }
});

test("onLongLinkEstablished resets to MIN", () => {
  const sh = make(false);
  for (let i = 0; i < 300; i++) beat(sh, true);
  assert.equal(sh.getNextHeartbeatInterval(), CEIL);
  sh.onLongLinkEstablished();
  assert.equal(sh.getNextHeartbeatInterval(), MIN_HEART_INTERVAL);
});

test("setOuterHeart overrides everything", () => {
  const sh = make(false);
  sh.setOuterHeart(123000);
  assert.equal(sh.getNextHeartbeatInterval(), 123000);
});
