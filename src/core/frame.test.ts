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

test("buildFrame: image message (msgType 3) derives media metadata (no bytes — lazy fetch)", () => {
  const msg = baseMsg({ msgId: "img-7", msgType: 3, text: "[图片]" });

  const frame = buildFrame(msg, { account: "default" });

  assert.equal(frame.media?.kind, "image");
  assert.equal(frame.media?.mimeType, "image/jpeg");
  assert.equal(frame.media?.fileName, "wechat-image-img-7.jpg");
  // Lazy: the broadcast frame carries metadata only — no URL, no local path.
  // The subscriber fetches the bytes on demand via POST /media after its gate.
  assert.equal(frame.media?.url, undefined);
  assert.equal(frame.media?.localPath, undefined);
  // The display text placeholder is preserved as the message body.
  assert.equal(frame.text, "[图片]");
});

test("buildFrame: opts.media takes precedence over intrinsic image detection", () => {
  const msg = baseMsg({ msgType: 3, text: "[图片]" });
  const frame = buildFrame(msg, {
    account: "default",
    media: { kind: "image", localPath: "/tmp/already.jpg" },
  });
  assert.equal(frame.media?.localPath, "/tmp/already.jpg");
});

test("buildFrame: file message (msgType 49, appmsg type 6) derives a 'file' attachment", () => {
  const content =
    '<msg><appmsg appid="wxeb7" sdkver="0"><title>症状.docx</title><type>6</type>' +
    "<appattach><totallen>159214</totallen><fileext>docx</fileext>" +
    "<attachid>@cdn_1</attachid></appattach></appmsg></msg>";
  const msg = baseMsg({ msgId: "file-9", msgType: 49, content, text: "[文件] 症状.docx" });

  const frame = buildFrame(msg, { account: "default" });

  assert.equal(frame.media?.kind, "file");
  assert.equal(
    frame.media?.mimeType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(frame.media?.fileName, "症状.docx");
  assert.equal(frame.text, "[文件] 症状.docx");
});

test("buildFrame: a type-74 file placeholder yields no media (suppressed upstream, but be safe)", () => {
  const content =
    "<msg><appmsg><title>症状.docx</title><type>74</type>" +
    "<appattach><fileext>docx</fileext></appattach></appmsg></msg>";
  const frame = buildFrame(baseMsg({ msgType: 49, content }), { account: "default" });
  assert.equal(frame.media, undefined);
});

test("buildFrame: non-media message has no media", () => {
  const frame = buildFrame(baseMsg({ msgType: 1 }), { account: "default" });
  assert.equal(frame.media, undefined);
});
