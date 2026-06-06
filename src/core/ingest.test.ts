import { test } from "node:test";
import assert from "node:assert/strict";

import type { NormalizedMessage } from "./client.js";
import type { Frame } from "../shared/frame.js";
import { openDb } from "./db.js";
import { handleInbound } from "./ingest.js";

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
  const deps = { account: "default", db, broadcast: (f: Frame) => sent.push(f) };

  assert.equal(handleInbound(baseMsg({ msgId: "dup" }), deps), true);
  assert.equal(handleInbound(baseMsg({ msgId: "dup" }), deps), false); // same id again

  assert.equal(sent.length, 1); // broadcast only once
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
      resolveName: (wxid) => (wxid === "wxid_alice" ? "Alice" : wxid === "g@chatroom" ? "The Group" : undefined),
    },
  );

  assert.equal(sent[0].from.name, "Alice");
  assert.equal(sent[0].chat.name, "The Group");
  db.close();
});
