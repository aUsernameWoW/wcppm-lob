/**
 * Test quote message parsing against captured WebSocket data.
 * Usage: node scripts/test-quote-parse.mjs
 */
import { readFileSync } from "fs";
import WebSocket from "ws";

const cfg = JSON.parse(readFileSync("local-config.json", "utf-8"));
const url = `${cfg.wsUrl}?authcode=${cfg.authcode}`;

// Inline the parsing logic from client.ts to test it directly
function extractXmlTag(content, tag) {
  const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.trim() || null;
}

function extractXmlAttr(content, tag, attr) {
  const tagMatch = content.match(new RegExp(`<${tag}\\s[^>]*${attr}="([^"]*)"`, "i"));
  return tagMatch?.[1] || null;
}

function summarizeQuotedContent(msgType, content) {
  if (msgType === 1) return content.length > 80 ? content.slice(0, 80) + "…" : content;
  if (msgType === 3) return "[图片]";
  if (msgType === 34) return "[语音]";
  if (msgType === 47) return "[表情]";
  if (msgType === 48) {
    const poiname = extractXmlAttr(content, "location", "poiname");
    return poiname ? `[位置] ${poiname}` : "[位置]";
  }
  if (msgType === 49) {
    const title = extractXmlTag(content, "title");
    if (title) return `[卡片] ${title}`;
    return "[卡片消息]";
  }
  return content.length > 60 ? content.slice(0, 60) + "…" : content || "[消息]";
}

function parseQuoteMessage(xml) {
  const appType = extractXmlTag(xml, "type");
  if (appType !== "57") return null;

  const referBlock = xml.match(/<refermsg>([\s\S]*?)<\/refermsg>/i)?.[1];
  if (!referBlock) return null;

  const referMsgId = extractXmlTag(referBlock, "svrid") ?? "";
  const referSenderWxid = extractXmlTag(referBlock, "chatusr") ?? "";
  const referDisplayName = extractXmlTag(referBlock, "displayname") ?? "";
  const referTypeStr = extractXmlTag(referBlock, "type") ?? "1";
  const referType = Number(referTypeStr) || 1;

  let referContent = extractXmlTag(referBlock, "content") ?? "";
  referContent = referContent.replace(/^\n+/, "");

  const referSummary = summarizeQuotedContent(referType, referContent);

  return {
    referMsgId,
    referSenderWxid,
    referDisplayName,
    referContent: referContent.slice(0, 100) + (referContent.length > 100 ? "…" : ""),
    referType,
    referSummary,
  };
}

console.log(`Connecting to ${cfg.wsUrl}?authcode=***...`);
const ws = new WebSocket(url);

const seen = new Set();
let quoteCount = 0;

ws.on("open", () => console.log("Connected. Listening for quote messages...\n"));

ws.on("message", (data) => {
  try {
    const envelope = JSON.parse(data.toString());
    const syncResp = envelope?.Data?.syncData ?? envelope?.Data?.data;
    if (!syncResp?.Data?.AddMsgs) return;

    for (const msg of syncResp.Data.AddMsgs) {
      if (msg.MsgType !== 49) continue;

      const dedupKey = `${msg.MsgId}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const content = msg.Content?.string ?? "";
      // Strip group prefix
      const colonIdx = content.indexOf(":\n");
      const xml = colonIdx > 0 ? content.substring(colonIdx + 2) : content;

      const quote = parseQuoteMessage(xml);
      if (!quote) continue;

      quoteCount++;
      const title = extractXmlTag(xml, "title") ?? "(no title)";

      console.log(`── Quote #${quoteCount} ──────────────────────────────`);
      console.log(`  MsgId:          ${msg.MsgId}`);
      console.log(`  Reply text:     ${title}`);
      console.log(`  referMsgId:     ${quote.referMsgId}`);
      console.log(`  referType:      ${quote.referType}`);
      console.log(`  referSender:    ${quote.referDisplayName} (${quote.referSenderWxid})`);
      console.log(`  referSummary:   ${quote.referSummary}`);
      console.log(`  referContent:   ${quote.referContent}`);
      console.log();

      // Build the body text as channel.ts would
      const replyLabel = quote.referDisplayName || quote.referSenderWxid || "unknown";
      const bodyText = `${title}\n\n[Replying to ${replyLabel}]\n${quote.referSummary}\n[/Replying]`;
      console.log(`  Full body text:`);
      console.log(`  ${bodyText.replace(/\n/g, "\n  ")}`);
      console.log();
    }
  } catch { /* ignore non-JSON */ }
});

ws.on("close", () => {
  console.log(`\nDone. Found ${quoteCount} quote messages.`);
  process.exit(0);
});

ws.on("error", (err) => console.error("WS error:", err.message));

// Auto-close after 15 seconds
setTimeout(() => {
  console.log(`\nTimeout. Found ${quoteCount} quote messages total.`);
  ws.close();
}, 15000);
