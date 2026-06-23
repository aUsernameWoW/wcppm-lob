import { test } from "node:test";
import assert from "node:assert/strict";

import type { NormalizedMessage } from "./client.js";
import type { Frame } from "../shared/frame.js";
import type { Logger } from "../shared/logger.js";
import { openDb } from "./db.js";
import { handleInbound } from "./ingest.js";

const noopLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

interface SpyLogger extends Logger {
  calls: { level: "info" | "warn" | "error" | "debug"; msg: string }[];
}
function spyLogger(): SpyLogger {
  const calls: SpyLogger["calls"] = [];
  const rec =
    (level: SpyLogger["calls"][number]["level"]) =>
    (...a: any[]) =>
      calls.push({ level, msg: a.map(String).join(" ") });
  return { calls, info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
}

function baseMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    msgId: "m1",
    fromUser: "wxid_peer",
    toUser: "wxid_self",
    msgType: 1,
    content: "hi",
    pushContent: "",
    msgSource: "",
    createTime: 1000,
    senderWxid: "",
    text: "hi",
    isGroup: false,
    groupId: null,
    isAtBot: false,
    quote: null,
    raw: {},
    ...overrides,
  };
}

test("handleInbound: a new message is recorded and broadcast (returns true)", () => {
  const db = openDb(":memory:");
  const sent: Frame[] = [];

  const result = handleInbound(baseMsg({ msgId: "m1" }), {
    account: "default",
    db,
    broadcast: (f) => sent.push(f),
    log: noopLogger,
  });

  assert.equal(result, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, "m1");
  // persisted to the inbound_log (so a reconnect could replay it)
  assert.deepEqual(db.getUndelivered("default", 0).map((r) => r.id), ["m1"]);
  db.close();
});

test("handleInbound: a duplicate message is NOT broadcast (returns false)", () => {
  const db = openDb(":memory:");
  const sent: Frame[] = [];
  const deps = { account: "default", db, broadcast: (f: Frame) => sent.push(f), log: noopLogger };

  assert.equal(handleInbound(baseMsg({ msgId: "dup" }), deps), true);
  assert.equal(handleInbound(baseMsg({ msgId: "dup" }), deps), false); // same id again

  assert.equal(sent.length, 1); // broadcast only once
  db.close();
});

test("handleInbound: logs receipt and broadcast at debug for a new message", () => {
  const db = openDb(":memory:");
  const log = spyLogger();

  handleInbound(baseMsg({ msgId: "n1" }), {
    account: "default",
    db,
    broadcast: () => {},
    log,
  });

  const debugs = log.calls.filter((c) => c.level === "debug").map((c) => c.msg);
  assert.ok(
    debugs.some((m) => m.includes("n1") && /recv/i.test(m)),
    `expected a debug 'recv' log carrying the id; got ${JSON.stringify(debugs)}`,
  );
  assert.ok(
    debugs.some((m) => m.includes("n1") && /broadcast/i.test(m)),
    `expected a debug 'broadcast' log carrying the id; got ${JSON.stringify(debugs)}`,
  );
  db.close();
});

test("handleInbound: logs a dropped duplicate at debug and never logs a broadcast for it", () => {
  const db = openDb(":memory:");
  const log = spyLogger();
  const deps = { account: "default", db, broadcast: () => {}, log };

  handleInbound(baseMsg({ msgId: "d1" }), deps);
  log.calls.length = 0; // focus assertions on the duplicate pass only
  handleInbound(baseMsg({ msgId: "d1" }), deps);

  const debugs = log.calls.filter((c) => c.level === "debug").map((c) => c.msg);
  assert.ok(
    debugs.some((m) => m.includes("d1") && /dup/i.test(m)),
    `expected a debug 'dup' log for the duplicate; got ${JSON.stringify(debugs)}`,
  );
  assert.ok(
    !debugs.some((m) => /broadcast/i.test(m)),
    `a duplicate must not log a broadcast; got ${JSON.stringify(debugs)}`,
  );
  db.close();
});

test("handleInbound: resolveName enriches from.name (and chat.name for groups)", () => {
  const db = openDb(":memory:");
  const sent: Frame[] = [];

  handleInbound(
    baseMsg({ isGroup: true, groupId: "g@chatroom", senderWxid: "wxid_alice", fromUser: "g@chatroom" }),
    {
      account: "default",
      db,
      broadcast: (f) => sent.push(f),
      log: noopLogger,
      resolveName: (wxid) => (wxid === "wxid_alice" ? "Alice" : wxid === "g@chatroom" ? "The Group" : undefined),
    },
  );

  assert.equal(sent[0].from.name, "Alice");
  assert.equal(sent[0].chat.name, "The Group");
  db.close();
});

test("handleInbound: an old message is still recorded but NOT broadcast when maxBroadcastAge is set", () => {
  const db = openDb(":memory:");
  const sent: Frame[] = [];
  const now = 1_700_000_000_000; // fixed ms clock
  const oldTs = now / 1000 - 600; // 600s old → past a 180s broadcast window

  const result = handleInbound(baseMsg({ msgId: "old1", createTime: oldTs }), {
    account: "default",
    db,
    broadcast: (f) => sent.push(f),
    log: noopLogger,
    maxBroadcastAge: 180,
    now: () => now,
  });

  assert.equal(result, true, "an old-but-new message is still recorded (returns true)");
  assert.equal(sent.length, 0, "an old message must NOT be dispatched to the agent");
  assert.deepEqual(
    db.getUndelivered("default", 0).map((r) => r.id),
    ["old1"],
    "but it IS persisted to the inbound_log",
  );
  db.close();
});

test("handleInbound: a new image message persists a lazy-fetch media descriptor", () => {
  const db = openDb(":memory:");
  const sent: Frame[] = [];

  handleInbound(
    baseMsg({
      msgId: "img-9", // stable id (NewMsgId) — used only as the frame/db key
      msgType: 3,
      fromUser: "wxid_peer",
      content: "<msg><img aeskey='K' cdnbigimgurl='U' length='4242'/></msg>",
      text: "[图片]",
      raw: { MsgId: 1681019322 }, // the small int32 MsgId the download API needs
    }),
    { account: "default", db, broadcast: (f) => sent.push(f), log: noopLogger },
  );

  // The broadcast frame advertises the image (metadata only, no bytes).
  assert.equal(sent[0].media?.kind, "image");
  assert.equal(sent[0].media?.localPath, undefined);

  // A SyncMessage-shaped descriptor was persisted under the (NewMsgId) frame id,
  // carrying the SMALL MsgId so extractImageMessageInfo downloads with the right id.
  const media = db.getMedia("default", "img-9");
  assert.equal(media?.kind, "image");
  const desc = JSON.parse(media!.descriptor);
  assert.equal(desc.MsgId, 1681019322);
  assert.equal(desc.MsgType, 3);
  assert.equal(desc.FromUserName.string, "wxid_peer");
  assert.match(desc.Content.string, /aeskey/);
  db.close();
});

test("handleInbound: a non-media message persists NO media descriptor", () => {
  const db = openDb(":memory:");
  handleInbound(baseMsg({ msgId: "txt-1", msgType: 1 }), {
    account: "default",
    db,
    broadcast: () => {},
    log: noopLogger,
  });
  assert.equal(db.getMedia("default", "txt-1"), undefined);
  db.close();
});

test("handleInbound: a recent message is still broadcast when maxBroadcastAge is set", () => {
  const db = openDb(":memory:");
  const sent: Frame[] = [];
  const now = 1_700_000_000_000;
  const recentTs = now / 1000 - 10; // 10s old → within the 180s window

  handleInbound(baseMsg({ msgId: "recent1", createTime: recentTs }), {
    account: "default",
    db,
    broadcast: (f) => sent.push(f),
    log: noopLogger,
    maxBroadcastAge: 180,
    now: () => now,
  });

  assert.equal(sent.length, 1, "a recent message is broadcast as before");
  assert.equal(sent[0].id, "recent1");
  db.close();
});
