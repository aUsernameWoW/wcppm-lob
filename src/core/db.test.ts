import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "./db.js";

test("recordInbound: a new id is inserted (true); the same id again is a duplicate (false)", () => {
  const db = openDb(":memory:");
  const entry = { id: "msg-1", account: "default", ts: 1000, payload: '{"text":"hi"}' };

  assert.equal(db.recordInbound(entry), true); // first time → newly inserted
  assert.equal(db.recordInbound(entry), false); // second time → INSERT OR IGNORE no-op

  db.close();
});

test("getUndelivered: returns un-acked rows in the account within the age window, oldest first", () => {
  const db = openDb(":memory:");
  db.recordInbound({ id: "a", account: "default", ts: 100, payload: "A" });
  db.recordInbound({ id: "b", account: "default", ts: 200, payload: "B" });
  db.recordInbound({ id: "c", account: "default", ts: 300, payload: "C" });
  db.recordInbound({ id: "x", account: "other", ts: 300, payload: "X" }); // different account

  db.markDelivered("b", 999); // b is acked → excluded

  // age window ts >= 150 → "a" too old (excluded), "b" acked (excluded), "x" wrong account → only "c"
  const recent = db.getUndelivered("default", 150);
  assert.deepEqual(recent.map((r) => r.id), ["c"]);

  // wider window ts >= 0 → "a" then "c" (oldest first), "b" still excluded (acked), "x" wrong account
  const all = db.getUndelivered("default", 0);
  assert.deepEqual(all.map((r) => r.id), ["a", "c"]);
  assert.equal(all[0].payload, "A");

  db.close();
});

test("pruneInbound: deletes rows with ts < cutoff and returns the number removed", () => {
  const db = openDb(":memory:");
  db.recordInbound({ id: "old1", account: "default", ts: 100, payload: "" });
  db.recordInbound({ id: "old2", account: "default", ts: 200, payload: "" });
  db.recordInbound({ id: "keep", account: "default", ts: 500, payload: "" });

  const removed = db.pruneInbound(300); // delete everything with ts < 300

  assert.equal(removed, 2);
  assert.deepEqual(db.getUndelivered("default", 0).map((r) => r.id), ["keep"]);

  db.close();
});

test("contacts: getContact returns the upserted contact, or undefined when unknown", () => {
  const db = openDb(":memory:");
  db.upsertContact({ account: "default", wxid: "wxid_1", name: "Alice", type: "friend", updatedAt: 10 });

  const c = db.getContact("default", "wxid_1");
  assert.equal(c?.name, "Alice");
  assert.equal(c?.type, "friend");

  assert.equal(db.getContact("default", "nope"), undefined);
  db.close();
});

test("contacts: re-upserting the same (account,wxid) updates in place, no duplicate row", () => {
  const db = openDb(":memory:");
  db.upsertContact({ account: "default", wxid: "g1", name: "Old Group", type: "group", updatedAt: 1 });
  db.upsertContact({ account: "default", wxid: "g1", name: "New Group", type: "group", updatedAt: 2 });

  const c = db.getContact("default", "g1");
  assert.equal(c?.name, "New Group");
  assert.equal(c?.updated_at, 2);

  db.close();
});
