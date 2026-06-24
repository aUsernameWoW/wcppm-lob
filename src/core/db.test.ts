import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openDb } from "./db.js";

test("openDb: creates missing parent directories for the db file", () => {
  const root = join(tmpdir(), `wcppm-db-${process.pid}-${Date.now()}`);
  const dbPath = join(root, "nested", "share", "state.db");
  try {
    const db = openDb(dbPath);
    db.recordInbound({ id: "x", account: "a", ts: 1, payload: "{}" });
    db.close();
    assert.ok(existsSync(dbPath), "db file should exist under freshly-created dirs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordInbound: a new id is inserted (true); the same id again is a duplicate (false)", () => {
  const db = openDb(":memory:");
  const entry = { id: "msg-1", account: "default", ts: 1000, payload: '{"text":"hi"}' };

  assert.equal(db.recordInbound(entry), true); // first time → newly inserted
  assert.equal(db.recordInbound(entry), false); // second time → INSERT OR IGNORE no-op

  db.close();
});

test("recordMedia/getMedia: stores a lazy-fetch descriptor keyed by message id", () => {
  const db = openDb(":memory:");
  assert.equal(db.getMedia("default", "img-1"), undefined);

  const inserted = db.recordMedia({
    id: "img-1",
    account: "default",
    kind: "image",
    descriptor: '{"msgId":"img-1","msgType":3}',
    ts: 1000,
  });
  assert.equal(inserted, true);

  const row = db.getMedia("default", "img-1");
  assert.equal(row?.kind, "image");
  assert.equal(row?.descriptor, '{"msgId":"img-1","msgType":3}');

  // Same id again is an INSERT OR IGNORE no-op (mirrors inbound dedup).
  assert.equal(db.recordMedia({ id: "img-1", account: "default", kind: "image", descriptor: "{}", ts: 2000 }), false);
  assert.equal(db.getMedia("default", "img-1")?.descriptor, '{"msgId":"img-1","msgType":3}');

  // Account-scoped: wrong account → miss.
  assert.equal(db.getMedia("other", "img-1"), undefined);

  db.close();
});

test("pruneMedia: deletes rows older than the cutoff, returns the count", () => {
  const db = openDb(":memory:");
  db.recordMedia({ id: "old", account: "default", kind: "image", descriptor: "{}", ts: 100 });
  db.recordMedia({ id: "new", account: "default", kind: "image", descriptor: "{}", ts: 500 });

  assert.equal(db.pruneMedia(300), 1);
  assert.equal(db.getMedia("default", "old"), undefined);
  assert.ok(db.getMedia("default", "new"));

  db.close();
});

test("getUndelivered: returns un-acked rows in the account within the age window, oldest first", () => {
  const db = openDb(":memory:");
  db.recordInbound({ id: "a", account: "default", ts: 100, payload: "A" });
  db.recordInbound({ id: "b", account: "default", ts: 200, payload: "B" });
  db.recordInbound({ id: "c", account: "default", ts: 300, payload: "C" });
  db.recordInbound({ id: "x", account: "other", ts: 300, payload: "X" }); // different account

  db.markDelivered("default", "b", 999); // b is acked → excluded

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

test("searchContacts: matches wxid or name substring, newest-updated first, respects limit", () => {
  const db = openDb(":memory:");
  db.upsertContact({ account: "default", wxid: "wxid_li", name: "李四", updatedAt: 100 });
  db.upsertContact({ account: "default", wxid: "wxid_zhang", name: "张三", updatedAt: 200 });
  db.upsertContact({ account: "other", wxid: "wxid_li", name: "李四", updatedAt: 300 });

  const byName = db.searchContacts("default", "李", 10);
  assert.deepEqual(byName.map((c) => c.wxid), ["wxid_li"]);

  const byWxid = db.searchContacts("default", "wxid_", 10);
  assert.deepEqual(byWxid.map((c) => c.wxid), ["wxid_zhang", "wxid_li"]); // newest updated_at first

  const limited = db.searchContacts("default", "wxid_", 1);
  assert.equal(limited.length, 1);

  const empty = db.searchContacts("default", "", 10); // empty q → all in account
  assert.equal(empty.length, 2);

  db.close();
});

test("searchContacts: treats LIKE metacharacters in q as literals", () => {
  const db = openDb(":memory:");
  db.upsertContact({ account: "default", wxid: "wxid_li", name: "李四", updatedAt: 100 });
  db.upsertContact({ account: "default", wxid: "wxidXli", name: "王五", updatedAt: 200 });

  // "_" must be literal: only wxid_li matches, not wxidXli
  const underscore = db.searchContacts("default", "wxid_li", 10);
  assert.deepEqual(underscore.map((c) => c.wxid), ["wxid_li"]);

  // "%" must be literal: nothing literally contains "%"
  const percent = db.searchContacts("default", "%", 10);
  assert.equal(percent.length, 0);

  db.close();
});

test("recordInbound: same NewMsgId in different accounts both persist (composite PK, no cross-account drop)", () => {
  const db = openDb(":memory:");
  // A WeChat NewMsgId is only unique WITHIN one account — two accounts can legitimately
  // produce the same id. The second must NOT be silently dropped as a "duplicate".
  assert.equal(db.recordInbound({ id: "dup", account: "A", ts: 100, payload: "fromA" }), true);
  assert.equal(db.recordInbound({ id: "dup", account: "B", ts: 100, payload: "fromB" }), true);

  // Re-inserting within the same account is still an idempotent no-op.
  assert.equal(db.recordInbound({ id: "dup", account: "A", ts: 100, payload: "fromA" }), false);

  assert.deepEqual(db.getUndelivered("A", 0).map((r) => r.payload), ["fromA"]);
  assert.deepEqual(db.getUndelivered("B", 0).map((r) => r.payload), ["fromB"]);

  db.close();
});

test("recordMedia: same id in different accounts both persist (composite PK)", () => {
  const db = openDb(":memory:");
  assert.equal(db.recordMedia({ id: "dup", account: "A", kind: "image", descriptor: "A", ts: 1 }), true);
  assert.equal(db.recordMedia({ id: "dup", account: "B", kind: "image", descriptor: "B", ts: 1 }), true);

  assert.equal(db.getMedia("A", "dup")?.descriptor, "A");
  assert.equal(db.getMedia("B", "dup")?.descriptor, "B");

  db.close();
});

test("markDelivered: account-scoped — acking one account's id leaves the other account's same id undelivered", () => {
  const db = openDb(":memory:");
  db.recordInbound({ id: "dup", account: "A", ts: 100, payload: "fromA" });
  db.recordInbound({ id: "dup", account: "B", ts: 100, payload: "fromB" });

  db.markDelivered("A", "dup", 999);

  assert.deepEqual(db.getUndelivered("A", 0).map((r) => r.id), []); // A acked
  assert.deepEqual(db.getUndelivered("B", 0).map((r) => r.id), ["dup"]); // B untouched

  db.close();
});

test("openDb: migrates an old id-only-PK database, preserving rows and enabling composite-PK behavior", () => {
  const root = join(tmpdir(), `wcppm-migrate-${process.pid}-${Date.now()}`);
  const dbPath = join(root, "state.db");
  try {
    mkdirSync(root, { recursive: true });
    // Stand up the OLD schema by hand (id-only PRIMARY KEY) and seed a legacy 'default' row.
    {
      const raw = new DatabaseSync(dbPath);
      raw.exec(`
        CREATE TABLE inbound_log (
          id TEXT PRIMARY KEY, account TEXT NOT NULL, ts INTEGER NOT NULL,
          payload TEXT NOT NULL, delivered_at INTEGER
        );
        CREATE TABLE media (
          id TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL,
          descriptor TEXT NOT NULL, ts INTEGER NOT NULL
        );
      `);
      raw.prepare("INSERT INTO inbound_log (id, account, ts, payload, delivered_at) VALUES (?,?,?,?,?)")
        .run("legacy", "default", 100, "old-payload", 42);
      raw.prepare("INSERT INTO media (id, account, kind, descriptor, ts) VALUES (?,?,?,?,?)")
        .run("legacy", "default", "image", "old-desc", 100);
      raw.close();
    }

    // openDb must migrate the existing tables to composite PK without losing data.
    const db = openDb(dbPath);

    // Legacy row survived, including its delivered_at (acked → excluded from undelivered).
    assert.deepEqual(db.getUndelivered("default", 0).map((r) => r.id), []);
    assert.deepEqual(db.recentInbound("default", 10).map((r) => r.payload), ["old-payload"]);
    assert.equal(db.getMedia("default", "legacy")?.descriptor, "old-desc");

    // Composite-PK behavior now works: a second account can reuse the same id.
    assert.equal(db.recordInbound({ id: "legacy", account: "B", ts: 200, payload: "fromB" }), true);
    assert.deepEqual(db.getUndelivered("B", 0).map((r) => r.payload), ["fromB"]);

    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recentInbound: newest-first rows scoped to account, respects limit", () => {
  const db = openDb(":memory:");
  db.recordInbound({ id: "a", account: "default", ts: 100, payload: '{"id":"a"}' });
  db.recordInbound({ id: "b", account: "default", ts: 200, payload: '{"id":"b"}' });
  db.recordInbound({ id: "x", account: "other", ts: 300, payload: '{"id":"x"}' });

  const rows = db.recentInbound("default", 10);
  assert.deepEqual(rows.map((r) => r.id), ["b", "a"]); // newest ts first, "other" excluded

  const limited = db.recentInbound("default", 1);
  assert.deepEqual(limited.map((r) => r.id), ["b"]);

  db.close();
});
