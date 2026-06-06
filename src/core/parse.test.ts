import { test } from "node:test";
import assert from "node:assert/strict";

import { WcppClient, type SyncMessage } from "./client.js";

// ──────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────

/** No-op logger satisfying the Logger interface (info/warn/error/debug). */
const stubLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Minimal config — host empty + port 8062. None of the parse/extract methods
 * under test touch the network, so an empty host is fine (baseUrl just becomes
 * "" and the proxy transport defaults to direct).
 */
function makeClient(): WcppClient {
  return new WcppClient({ host: "", port: 8062 }, stubLog);
}

/** Build a minimal SyncMessage with the fields the extractors actually read. */
function syncMsg(overrides: Partial<SyncMessage>): SyncMessage {
  return {
    MsgId: 123456,
    FromUserName: { string: "wxid_sender" },
    ToUserName: { string: "wxid_self" },
    MsgType: 1,
    Content: { string: "" },
    CreateTime: 1775677433,
    NewMsgId: 7654321,
    MsgSeq: 0,
    ...overrides,
  };
}

// A MsgType-49 appType-57 quote/reply payload with a <refermsg> block.
const QUOTE_XML = `<?xml version="1.0"?>
<msg>
  <appmsg appid="" sdkver="0">
    <title>这是我的回复</title>
    <type>57</type>
    <refermsg>
      <type>1</type>
      <svrid>8901234567890123456</svrid>
      <fromusr>12345678@chatroom</fromusr>
      <chatusr>wxid_original_sender</chatusr>
      <displayname>原始发送者</displayname>
      <content>被引用的原始消息文本</content>
    </refermsg>
  </appmsg>
  <fromusername>wxid_replier</fromusername>
</msg>`;

// A MsgType-49 appType-5 link card — NOT a quote, parseQuoteMessage should return null.
const LINK_CARD_XML = `<?xml version="1.0"?>
<msg>
  <appmsg appid="wx123" sdkver="0">
    <title>分享的文章标题</title>
    <type>5</type>
    <url>https://example.com/article</url>
  </appmsg>
</msg>`;

// MsgType-34 voice XML.
// Note: the extractor's `bufid`/`voicelength`/`length` regexes accept the
// attribute form, but `aeskey`/`voiceurl`/`filename` are only matched as
// nested <tag>...</tag> (or CDATA) elements — so those are emitted as elements.
const VOICE_XML = `<?xml version="1.0"?>
<msg>
  <voicemsg endflag="1" cancelflag="0" forwardflag="0" voiceformat="4"
    voicelength="3200" length="2845" bufid="298464183226368000">
    <aeskey>a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6</aeskey>
    <voiceurl><![CDATA[3052020100044b30490201000204...]]></voiceurl>
  </voicemsg>
</msg>`;

// MsgType-3 image XML.
// `md5`/`length` use attribute form (extractor supports it); `aeskey` and the
// cdn*url fields are matched only as nested elements, so they are emitted so.
const IMAGE_XML = `<?xml version="1.0"?>
<msg>
  <img length="184320" hdlength="184320" md5="d41d8cd98f00b204e9800998ecf8427e">
    <aeskey>0f1e2d3c4b5a69788796a5b4c3d2e1f0</aeskey>
    <cdnthumburl>3052020100044b3049THUMB...</cdnthumburl>
    <cdnmidimgurl>3052020100044b3049MIDIMG...</cdnmidimgurl>
    <cdnbigimgurl>3052020100044b3049BIGIMG...</cdnbigimgurl>
  </img>
</msg>`;

// MsgType-43 video XML.
// `length`/`playlength`/`md5`/`newmd5` use attribute form; `aeskey` and the
// cdn*url fields are matched only as nested elements.
const VIDEO_XML = `<?xml version="1.0"?>
<msg>
  <videomsg length="2048576" playlength="12" cdnthumblength="9024"
    md5="098f6bcd4621d373cade4e832627b4f6"
    newmd5="5d41402abc4b2a76b9719d911017c592">
    <aeskey>9988776655443322110aabbccddeeff0</aeskey>
    <cdnvideourl>3052020100044b3049VIDEO...</cdnvideourl>
    <cdnthumburl>3052020100044b3049THUMB...</cdnthumburl>
  </videomsg>
</msg>`;

// ──────────────────────────────────────────────
// parseQuoteMessage
// ──────────────────────────────────────────────

test("parseQuoteMessage: appType-57 refermsg → QuoteInfo fields", () => {
  const client = makeClient();
  const quote = client.parseQuoteMessage(QUOTE_XML);

  assert.ok(quote, "expected a non-null QuoteInfo for an appType-57 payload");
  assert.equal(quote.referMsgId, "8901234567890123456");
  assert.equal(quote.referSenderWxid, "wxid_original_sender");
  assert.equal(quote.referDisplayName, "原始发送者");
  assert.equal(quote.referType, 1);
  assert.equal(quote.referContent, "被引用的原始消息文本");
  // referType 1 (text) → summary is the (short) content verbatim.
  assert.equal(quote.referSummary, "被引用的原始消息文本");
});

test("parseQuoteMessage: non-quote appType-5 link card → null", () => {
  const client = makeClient();
  assert.equal(client.parseQuoteMessage(LINK_CARD_XML), null);
});

test("parseQuoteMessage: plain text (no <type>57>) → null", () => {
  const client = makeClient();
  assert.equal(client.parseQuoteMessage("just some plain text, not xml"), null);
});

// ──────────────────────────────────────────────
// extractVoiceMessageInfo
// ──────────────────────────────────────────────

test("extractVoiceMessageInfo: MsgType 34 → bufid/length/aesKey", () => {
  const client = makeClient();
  const msg = syncMsg({ MsgType: 34, Content: { string: VOICE_XML }, MsgId: 555 });
  const info = client.extractVoiceMessageInfo(msg);

  assert.ok(info, "expected voice info for a MsgType-34 message");
  assert.equal(info.bufid, "298464183226368000");
  // voicelength="3200" wins over length="2845" (regex tries voicelength first).
  assert.equal(info.length, 3200);
  assert.equal(info.aesKey, "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
  assert.equal(info.fromUserName, "wxid_sender");
  assert.equal(info.msgId, 555);
});

test("extractVoiceMessageInfo: non-voice MsgType (1) → null", () => {
  const client = makeClient();
  const msg = syncMsg({ MsgType: 1, Content: { string: "hello" } });
  assert.equal(client.extractVoiceMessageInfo(msg), null);
});

// ──────────────────────────────────────────────
// extractImageMessageInfo
// ──────────────────────────────────────────────

test("extractImageMessageInfo: MsgType 3 → aesKey/cdn urls/md5", () => {
  const client = makeClient();
  const msg = syncMsg({ MsgType: 3, Content: { string: IMAGE_XML }, MsgId: 777 });
  const info = client.extractImageMessageInfo(msg);

  assert.ok(info, "expected image info for a MsgType-3 message");
  assert.equal(info.aesKey, "0f1e2d3c4b5a69788796a5b4c3d2e1f0");
  assert.equal(info.cdnMidImgUrl, "3052020100044b3049MIDIMG...");
  assert.equal(info.cdnBigImgUrl, "3052020100044b3049BIGIMG...");
  assert.equal(info.cdnThumbUrl, "3052020100044b3049THUMB...");
  assert.equal(info.md5, "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(info.fileLength, 184320);
  assert.equal(info.msgId, 777);
});

test("extractImageMessageInfo: non-image MsgType (34) → null", () => {
  const client = makeClient();
  const msg = syncMsg({ MsgType: 34, Content: { string: VOICE_XML } });
  assert.equal(client.extractImageMessageInfo(msg), null);
});

// ──────────────────────────────────────────────
// extractVideoMessageInfo
// ──────────────────────────────────────────────

test("extractVideoMessageInfo: MsgType 43 → cdnVideoUrl/playLengthSeconds/aesKey/md5", () => {
  const client = makeClient();
  const msg = syncMsg({ MsgType: 43, Content: { string: VIDEO_XML }, MsgId: 999 });
  const info = client.extractVideoMessageInfo(msg);

  assert.ok(info, "expected video info for a MsgType-43 message");
  assert.equal(info.cdnVideoUrl, "3052020100044b3049VIDEO...");
  assert.equal(info.cdnThumbUrl, "3052020100044b3049THUMB...");
  assert.equal(info.playLengthSeconds, 12);
  assert.equal(info.aesKey, "9988776655443322110aabbccddeeff0");
  assert.equal(info.md5, "098f6bcd4621d373cade4e832627b4f6");
  assert.equal(info.newMd5, "5d41402abc4b2a76b9719d911017c592");
  assert.equal(info.fileLength, 2048576);
  assert.equal(info.msgId, 999);
});

test("extractVideoMessageInfo: non-video MsgType (3) → null", () => {
  const client = makeClient();
  const msg = syncMsg({ MsgType: 3, Content: { string: IMAGE_XML } });
  assert.equal(client.extractVideoMessageInfo(msg), null);
});

// ──────────────────────────────────────────────
// resolveMedia / isMediaMessage
// ──────────────────────────────────────────────

test("resolveMedia: voice message → kind 'voice'", () => {
  const client = makeClient();
  const msg = syncMsg({ MsgType: 34, Content: { string: VOICE_XML } });
  const media = client.resolveMedia(msg);
  assert.ok(media, "expected resolved media for a voice message");
  assert.equal(media.kind, "voice");
  assert.equal(client.isMediaMessage(msg), true);
});

test("resolveMedia: image message → kind 'image'", () => {
  const client = makeClient();
  const msg = syncMsg({ MsgType: 3, Content: { string: IMAGE_XML } });
  const media = client.resolveMedia(msg);
  assert.ok(media, "expected resolved media for an image message");
  assert.equal(media.kind, "image");
  assert.equal(client.isMediaMessage(msg), true);
});

test("resolveMedia: video message → kind 'video'", () => {
  const client = makeClient();
  const msg = syncMsg({ MsgType: 43, Content: { string: VIDEO_XML } });
  const media = client.resolveMedia(msg);
  assert.ok(media, "expected resolved media for a video message");
  assert.equal(media.kind, "video");
  assert.equal(client.isMediaMessage(msg), true);
});

test("resolveMedia / isMediaMessage: plain text (MsgType 1) → null / false", () => {
  const client = makeClient();
  const msg = syncMsg({ MsgType: 1, Content: { string: "just a normal text message" } });
  assert.equal(client.resolveMedia(msg), null);
  assert.equal(client.isMediaMessage(msg), false);
});
