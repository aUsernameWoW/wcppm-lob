import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_HEART_INTERVAL, MAX_HEART_INTERVAL, HEART_STEP, SUCCESS_STEP,
  MAX_HEART_FAIL_COUNT, BASE_SUCC_COUNT, NET_STABLE_TEST_COUNT,
} from "./constants.js";
import { freshNetInfo } from "./types.js";

test("Mars constants match config.h verbatim", () => {
  assert.equal(MIN_HEART_INTERVAL, 210000);
  assert.equal(MAX_HEART_INTERVAL, 600000);
  assert.equal(HEART_STEP, 60000);
  assert.equal(SUCCESS_STEP, 20000);
  assert.equal(MAX_HEART_FAIL_COUNT, 2);
  assert.equal(BASE_SUCC_COUNT, 5);
  assert.equal(NET_STABLE_TEST_COUNT, 3);
});

test("freshNetInfo starts at MIN and unstable", () => {
  const n = freshNetInfo("egress:direct");
  assert.equal(n.curHeart, MIN_HEART_INTERVAL);
  assert.equal(n.isStable, false);
  assert.equal(n.succHeartCount, 0);
  assert.equal(n.netDetail, "egress:direct");
});
