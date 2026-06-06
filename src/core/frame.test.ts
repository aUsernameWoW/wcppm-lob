import { test } from "node:test";
import assert from "node:assert/strict";

import type { NormalizedMessage } from "./client.js";
import { buildFrame } from "./frame.js";

function baseMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    msgId: "stable-1",
    fromUser: "wxid_peer",
    toUser: "wxid_self",
    msgType: 1,
    content: "hi",
    pushContent: "",
    msgSource: "",
    createTime: 1775677433,
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

test("buildFrame: group message → from=member, chat=group, mentionedMe from isAtBot", () => {
  const msg = baseMsg({
    isGroup: true,
    groupId: "12345@chatroom",
    fromUser: "12345@chatroom",
    senderWxid: "wxid_alice",
    text: "@bot hello",
    isAtBot: true,
  });

  const frame = buildFrame(msg, { account: "default" });

  assert.equal(frame.type, "message");
  assert.equal(frame.id, "stable-1");
  assert.equal(frame.account, "default");
  assert.equal(frame.chatType, "group");
  assert.equal(frame.from.wxid, "wxid_alice");
  assert.equal(frame.chat.id, "12345@chatroom");
  assert.equal(frame.text, "@bot hello");
  assert.equal(frame.mentionedMe, true);
  assert.equal(frame.ts, 1775677433);
  assert.equal(frame.media, undefined);
});

test("buildFrame: direct message → from=peer, chat=peer, mentionedMe always false", () => {
  const msg = baseMsg({
    isGroup: false,
    fromUser: "wxid_bob",
    senderWxid: "",
    text: "hello dm",
    isAtBot: true, // even if set, DMs report false (mention is a group concept)
  });

  const frame = buildFrame(msg, { account: "acct2" });

  assert.equal(frame.chatType, "direct");
  assert.equal(frame.from.wxid, "wxid_bob");
  assert.equal(frame.chat.id, "wxid_bob");
  assert.equal(frame.mentionedMe, false);
  assert.equal(frame.account, "acct2");
});

test("buildFrame: derives from.name from pushContent ('Nick : text')", () => {
  const msg = baseMsg({ fromUser: "wxid_a", senderWxid: "", pushContent: "Alice : hello there" });
  const frame = buildFrame(msg, { account: "default" });
  assert.equal(frame.from.name, "Alice");
});

test("buildFrame: maps msg.quote → frame.quote", () => {
  const msg = baseMsg({
    quote: {
      referMsgId: "q9",
      referSenderWxid: "wxid_q",
      referDisplayName: "Quoted Bob",
      referContent: "...",
      referType: 1,
      referSummary: "the quoted text",
    },
  });
  const frame = buildFrame(msg, { account: "default" });
  assert.equal(frame.quote?.id, "q9");
  assert.equal(frame.quote?.summary, "the quoted text");
  assert.equal(frame.quote?.senderName, "Quoted Bob");
  assert.equal(frame.quote?.senderWxid, "wxid_q");
});

test("buildFrame: no quote → frame.quote is undefined", () => {
  const frame = buildFrame(baseMsg(), { account: "default" });
  assert.equal(frame.quote, undefined);
});

test("buildFrame: media descriptor in opts is attached to the frame", () => {
  const msg = baseMsg({ msgType: 3, text: "[image]" });

  const frame = buildFrame(msg, {
    account: "default",
    media: { kind: "image", mimeType: "image/jpeg", fileName: "x.jpg", url: "https://cdn/x" },
  });

  assert.equal(frame.media?.kind, "image");
  assert.equal(frame.media?.url, "https://cdn/x");
});
