/**
 * Offline test: parse quote messages from the captured WS dump.
 * Usage: node scripts/test-quote-offline.mjs
 */
import { readFileSync } from "fs";

const DUMP_FILE = "/tmp/claude-1000/-home-radxa-wcppm-lob/8469db76-230d-474e-a019-a06cbeee3337/tasks/bw3tz3w0s.output";

// Inline parsing logic (mirrors client.ts)
function extractXmlTag(content, tag) {
  const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.trim() || null;
}

function extractXmlAttr(content, tag, attr) {
  const tagMatch = content.match(new RegExp(`<${tag}\\s[^>]*${attr}="([^"]*)"`, "i"));
  return tagMatch?.[1] || null;
}

function unescapeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
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
  referContent = unescapeXmlEntities(referContent).replace(/^\n+/, "");

  const referSummary = summarizeQuotedContent(referType, referContent);

  return { referMsgId, referSenderWxid, referDisplayName, referContent, referType, referSummary };
}

// Parse the dump file: split on ═ separator lines, extract JSON blobs
const raw = readFileSync(DUMP_FILE, "utf-8");
const blocks = raw.split(/^═{40,}$/m).filter(b => b.trim().startsWith("{"));

const seen = new Set();
let quoteCount = 0;
let totalMsgs = 0;

for (const block of blocks) {
  let envelope;
  try { envelope = JSON.parse(block.trim()); } catch { continue; }

  const syncResp = envelope?.Data?.syncData ?? envelope?.Data?.data;
  if (!syncResp?.Data?.AddMsgs) continue;

  for (const msg of syncResp.Data.AddMsgs) {
    totalMsgs++;
    if (msg.MsgType !== 49) continue;

    const dedupKey = `${msg.MsgId}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const content = msg.Content?.string ?? "";
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

    const replyLabel = quote.referDisplayName || quote.referSenderWxid || "unknown";
    const bodyText = `${title}\n\n[Replying to ${replyLabel}]\n${quote.referSummary}\n[/Replying]`;
    console.log(`  ── Full dispatch body ──`);
    console.log(`  ${bodyText.replace(/\n/g, "\n  ")}`);
    console.log();
  }
}

console.log(`Total messages scanned: ${totalMsgs}`);
console.log(`Quote messages found: ${quoteCount}`);
console.log(quoteCount === 8 ? "✅ All 8 quote messages parsed!" : `⚠️  Expected 8, got ${quoteCount}`);
