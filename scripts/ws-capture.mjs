/**
 * Quick WebSocket capture script — connects to WCPP MAX and dumps raw messages.
 * Usage: node scripts/ws-capture.mjs
 */
import { readFileSync } from "fs";
import WebSocket from "ws";

const cfg = JSON.parse(readFileSync("local-config.json", "utf-8"));
const url = `${cfg.wsUrl}?authcode=${cfg.authcode}`;

console.log(`Connecting to ${cfg.wsUrl}?authcode=***...`);

const ws = new WebSocket(url);

ws.on("open", () => console.log("Connected. Waiting for messages...\n"));

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data.toString());
    // Pretty-print full envelope
    console.log("═".repeat(80));
    console.log(JSON.stringify(msg, null, 2));
    console.log("═".repeat(80) + "\n");
  } catch {
    console.log("RAW:", data.toString().slice(0, 500));
  }
});

ws.on("close", (code, reason) => {
  console.log(`Disconnected: code=${code} reason=${reason}`);
});

ws.on("error", (err) => {
  console.error("WS error:", err.message);
});
