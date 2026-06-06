#!/usr/bin/env node
// Forge a WCPPM webhook push and POST it to our local listener, to verify the
// webhook receive path works end-to-end (signature verify + pipeline ingest).
//
// Reads webhook* settings from ~/.openclaw/openclaw.json (channels.wechatpadpro).
// Signature scheme (must match src/client.ts:verifyWebhookSignature):
//   HMAC-SHA256(secret, `${Wxid}:${MessageType}:${Timestamp}`) hex-lowercase
//
// Usage:
//   node tools/forge-webhook.mjs [valid|bad|unsigned] [text] [fromUser]
//     valid    (default) correctly-signed envelope  -> expect 200 {"ok":true}
//     bad      tampered signature                   -> expect 401 invalid signature
//     unsigned empty Signature                      -> expect 200 dropped (silentDropUnsigned)
//
// Env overrides: TARGET=http://host:port  (defaults to webhookHost:webhookPort+webhookPath)

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2] || "valid";
const text = process.argv[3] || "[forge-webhook] test " + new Date().toISOString();
const fromUser = process.argv[4] || "wxid_kgsx9vaid5no22"; // in allowFrom -> passes DM gate

const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8")).channels.wechatpadpro;

const secret = cfg.webhookSecret || "";
const host = cfg.webhookHost === "0.0.0.0" ? "127.0.0.1" : (cfg.webhookHost || "127.0.0.1");
const port = cfg.webhookPort || 8000;
const path = cfg.webhookPath || "/webhook";
const target = process.env.TARGET || `http://${host}:${port}`;
const url = target + path;

const now = Math.floor(Date.now() / 1000);
const uniq = Date.now(); // unique msgId/newMsgId so dedup never swallows a re-run

const Wxid = cfg.botWxid || "wxid_botselftest"; // only used as HMAC input; this.wxid already set from login
const MessageType = "message";

const envelope = {
  MessageType,
  Timestamp: now,
  Wxid,
  IsSelf: false,
  Signature: "", // filled below
  Data: {
    messages: [
      {
        createTime: now,
        fromUser,
        fromNick: "ForgeTester",
        toUser: Wxid,
        isSelf: false,
        msgId: uniq % 2147483647,
        newMsgId: uniq,
        msgType: 1, // text — in allowMsgTypes
        text,
        pushContent: "ForgeTester : " + text,
      },
    ],
  },
};

const signingInput = `${envelope.Wxid}:${envelope.MessageType}:${envelope.Timestamp}`;
const sig = createHmac("sha256", secret).update(signingInput).digest("hex");

if (mode === "valid") envelope.Signature = sig;
else if (mode === "bad") envelope.Signature = sig.slice(0, -4) + "dead";
else if (mode === "unsigned") envelope.Signature = "";
else {
  console.error(`unknown mode "${mode}" — use valid|bad|unsigned`);
  process.exit(2);
}

const body = JSON.stringify(envelope);

console.log(`→ POST ${url}`);
console.log(`  mode=${mode}  signingInput="${signingInput}"`);
console.log(`  Signature=${envelope.Signature ? envelope.Signature.slice(0, 16) + "…" : "(empty)"}`);
console.log(`  msg: from=${fromUser} newMsgId=${uniq} text="${text}"`);

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});
const respText = await res.text();
console.log(`← HTTP ${res.status}`);
console.log(`  ${respText}`);
