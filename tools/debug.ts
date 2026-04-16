#!/usr/bin/env npx tsx
/**
 * WCPP MAX debug CLI — standalone tool for testing the WeChat bridge
 * without running the full OpenClaw stack.
 *
 * Usage:
 *   npx tsx tools/debug.ts <command> [args...]
 *
 * Commands:
 *   status          Check if the server is reachable and authcode is valid
 *   newinit         Call /Login/Newinit to establish longlink
 *   heartbeat       Call /Login/HeartBeatLong
 *   sync [n]        Poll /Msg/Sync n times (default 1) and print messages
 *   ws [seconds]    Connect WebSocket and listen for messages (default 30s)
 *   send <to> <text>  Send a text message
 *   search <keyword>  Search for a contact by WeChat ID / phone / etc.
 *   contacts        Fetch contact list
 *   recv [seconds]  Combined: newinit + sync poll loop, printing messages live
 *
 * Config is read from local-config.json in the project root:
 *   { "host": "...", "authcode": "...", "wsUrl": "ws://..." }
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import WebSocket from "ws";

// ── Config ──────────────────────────────────────

interface DebugConfig {
  host: string;
  port?: number;
  authcode: string;
  wsUrl?: string;
}

function loadConfig(): DebugConfig {
  const configPath = resolve(import.meta.dirname ?? ".", "..", "local-config.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw) as DebugConfig;
    if (!cfg.host || !cfg.authcode) {
      console.error("local-config.json must have 'host' and 'authcode'");
      process.exit(1);
    }
    return cfg;
  } catch (e: any) {
    console.error(`Failed to read ${configPath}: ${e.message}`);
    process.exit(1);
  }
}

function baseUrl(cfg: DebugConfig): string {
  return `http://${cfg.host}:${cfg.port ?? 8062}`;
}

function authQuery(cfg: DebugConfig): string {
  return `authcode=${cfg.authcode}`;
}

// ── Helpers ─────────────────────────────────────

async function api(
  cfg: DebugConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const url = `${baseUrl(cfg)}/api${path}?${authQuery(cfg)}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

function pretty(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function summarizeMsg(msg: any): string {
  const from = msg.FromUserName?.string ?? "?";
  const to = msg.ToUserName?.string ?? "?";
  const type = msg.MsgType;
  let content = msg.Content?.string ?? "";

  // For group messages, split sender
  const isGroup = from.includes("@chatroom");
  let sender = from;
  if (isGroup) {
    const idx = content.indexOf(":\n");
    if (idx > 0) {
      sender = content.substring(0, idx);
      content = content.substring(idx + 2);
    }
  }

  // Truncate long content
  if (content.length > 120) content = content.substring(0, 120) + "...";
  // Escape newlines for display
  content = content.replace(/\n/g, "\\n");

  const dir = isGroup ? `[${from}] ${sender}` : from;
  const push = msg.PushContent ? ` (push: ${msg.PushContent.substring(0, 60)})` : "";
  return `  MsgType=${type} ${dir} -> ${to}: ${content}${push}`;
}

// ── Commands ────────────────────────────────────

async function cmdStatus(cfg: DebugConfig) {
  console.log(`Server: ${baseUrl(cfg)}`);
  console.log(`Authcode: ${cfg.authcode.substring(0, 8)}...`);
  try {
    const data = await api(cfg, "POST", "/Msg/Sync", { Scene: 0, Synckey: "" });
    console.log(`Sync test: ${data.Success ? "OK" : "FAILED"} (Code=${data.Code})`);
    if (data.Data?.ModUserInfos?.[0]) {
      const u = data.Data.ModUserInfos[0];
      console.log(`wxid: ${u.UserName?.string}`);
      console.log(`Nickname: ${u.NickName?.string}`);
    }
    const msgs = data.Data?.AddMsgs?.length ?? 0;
    console.log(`Pending messages: ${msgs}`);
    console.log(`ContinueFlag: ${data.Data?.ContinueFlag}`);
  } catch (e: any) {
    console.error(`Connection failed: ${e.message}`);
  }
}

async function cmdNewinit(cfg: DebugConfig) {
  console.log("Calling /Login/Newinit...");
  try {
    const data = await api(cfg, "POST", "/Login/Newinit");
    console.log(`Success: ${data.Success}`);
    if (data.Data?.ModUserInfos?.[0]) {
      console.log(`wxid: ${data.Data.ModUserInfos[0].UserName?.string}`);
      console.log(`Nickname: ${data.Data.ModUserInfos[0].NickName?.string}`);
    }
    console.log(`ContinueFlag: ${data.Data?.ContinueFlag}`);
    console.log(`CurrentSynckey length: ${data.Data?.CurrentSynckey?.iLen}`);
    console.log(`MaxSynckey length: ${data.Data?.MaxSynckey?.iLen}`);
    const msgs = data.Data?.AddMsgs?.length ?? 0;
    if (msgs > 0) {
      console.log(`\nMessages (${msgs}):`);
      for (const m of data.Data.AddMsgs) console.log(summarizeMsg(m));
    }
  } catch (e: any) {
    console.error(`Newinit failed: ${e.message}`);
  }
}

async function cmdHeartbeat(cfg: DebugConfig) {
  console.log("Calling /Login/HeartBeatLong...");
  try {
    const data = await api(cfg, "POST", "/Login/HeartBeatLong");
    console.log(`Success: ${data.Success} (Message: ${data.Message})`);
    if (data.Data?.NextTime != null) {
      console.log(`NextTime: ${data.Data.NextTime}s`);
    }
  } catch (e: any) {
    console.error(`HeartBeatLong failed: ${e.message}`);
  }
}

async function cmdSync(cfg: DebugConfig, rounds: number = 1) {
  let synckey = "";
  let totalMsgs = 0;

  for (let i = 0; i < rounds; i++) {
    if (rounds > 1) console.log(`\n--- Poll ${i + 1}/${rounds} [${timestamp()}] ---`);

    try {
      const data = await api(cfg, "POST", "/Msg/Sync", { Scene: 0, Synckey: synckey });
      if (!data.Success) {
        console.error(`Sync failed: Code=${data.Code} ${data.Message}`);
        break;
      }

      // Update synckey
      if (data.Data?.KeyBuf?.buffer) synckey = data.Data.KeyBuf.buffer;

      const msgs = data.Data?.AddMsgs ?? [];
      const contacts = data.Data?.ModContacts ?? [];
      totalMsgs += msgs.length;

      console.log(`Messages: ${msgs.length}, Contacts: ${contacts.length}, ContinueFlag: ${data.Data?.ContinueFlag}`);

      for (const m of msgs) console.log(summarizeMsg(m));

      for (const c of contacts.slice(0, 5)) {
        const name = c.NickName?.string || c.UserName?.string || "?";
        console.log(`  Contact: ${c.UserName?.string} (${name})`);
      }
      if (contacts.length > 5) console.log(`  ... and ${contacts.length - 5} more contacts`);

      // If more data available, poll again immediately
      if (data.Data?.ContinueFlag && i === rounds - 1 && rounds === 1) {
        console.log("\nContinueFlag != 0, there may be more data. Run with more rounds.");
      }
    } catch (e: any) {
      console.error(`Sync error: ${e.message}`);
      break;
    }

    if (i < rounds - 1) await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\nTotal messages received: ${totalMsgs}`);
}

async function cmdWs(cfg: DebugConfig, seconds: number = 30) {
  const wsUrl = cfg.wsUrl
    ? `${cfg.wsUrl}?authcode=${cfg.authcode}`
    : `ws://${cfg.host}:8089/ws/sync?authcode=${cfg.authcode}`;

  console.log(`Connecting to ${wsUrl.replace(/authcode=[^&]+/, "authcode=***")}...`);

  const ws = new WebSocket(wsUrl);
  let msgCount = 0;

  const timeout = setTimeout(() => {
    console.log(`\n--- ${seconds}s elapsed, received ${msgCount} messages. Closing. ---`);
    ws.close();
  }, seconds * 1000);

  ws.on("open", () => console.log(`Connected [${timestamp()}]`));

  ws.on("message", (data: WebSocket.Data) => {
    msgCount++;
    try {
      const parsed = JSON.parse(data.toString());
      // Try to unwrap envelope
      const inner = parsed.Data?.syncData ?? parsed.Data?.data ?? parsed.Data;
      const msgs = inner?.Data?.AddMsgs ?? inner?.AddMsgs ?? [];
      console.log(`\n[${timestamp()}] WS message #${msgCount} (${data.toString().length} bytes, ${msgs.length} msgs)`);
      for (const m of msgs) console.log(summarizeMsg(m));
      if (msgs.length === 0) {
        // Print abbreviated raw
        const str = data.toString();
        console.log(`  Raw: ${str.substring(0, 300)}${str.length > 300 ? "..." : ""}`);
      }
    } catch {
      const str = data.toString();
      console.log(`\n[${timestamp()}] WS message #${msgCount} (${str.length} bytes, unparseable)`);
      console.log(`  Raw: ${str.substring(0, 300)}`);
    }
  });

  ws.on("close", (code) => {
    console.log(`WebSocket closed (code=${code}) after ${msgCount} messages`);
    clearTimeout(timeout);
    if (code === 1006 && msgCount === 0) {
      console.log("\nHint: Server dropped the connection immediately (0412 WS regression?).");
      console.log("Try 'recv' command instead — it uses Sync polling which works reliably.");
    }
  });

  ws.on("error", (err) => console.error(`WebSocket error: ${err.message}`));

  // Keep process alive
  await new Promise<void>(resolve => {
    ws.on("close", () => resolve());
    setTimeout(() => resolve(), (seconds + 2) * 1000);
  });
}

async function cmdSend(cfg: DebugConfig, to: string, text: string) {
  console.log(`Sending to '${to}': ${text}`);
  try {
    const data = await api(cfg, "POST", "/Msg/SendTxt", {
      ToWxid: to,
      Content: text,
      Type: 1,
    });
    const item = data.Data?.List?.[0];
    if (item) {
      console.log(`Ret: ${item.Ret}${item.Ret === 0 ? " (OK)" : " (FAILED)"}`);
      console.log(`NewMsgId: ${item.NewMsgId}`);
      console.log(`ServerTime: ${item.servertime}`);
    } else {
      console.log(`Response: ${pretty(data)}`);
    }
    if (item?.Ret !== 0) {
      console.log("\nHint: Ret != 0 usually means the target is not a friend.");
      console.log("Make sure 'to' is the UserName (e.g. 'gxnnycz'), not the underlying wxid.");
    }
  } catch (e: any) {
    console.error(`Send failed: ${e.message}`);
  }
}

async function cmdSearch(cfg: DebugConfig, keyword: string) {
  console.log(`Searching for '${keyword}'...`);
  try {
    const data = await api(cfg, "POST", "/Friend/Search", {
      keyword,
      fromScene: 0,
      searchScene: 1,
      opcode: 0,
    });
    if (data.Success && data.Data) {
      const d = data.Data;
      console.log(`UserName: ${d.UserName?.string}`);
      console.log(`NickName: ${d.NickName?.string}`);
      console.log(`wxid: ${d.Pyinitial?.string}`);
      console.log(`Sex: ${d.Sex === 1 ? "M" : d.Sex === 2 ? "F" : "?"}`);
      console.log(`Location: ${d.Province}, ${d.City}, ${d.Country}`);
      console.log(`BigHeadImg: ${d.BigHeadImgUrl}`);
    } else {
      console.log(`Search failed: ${data.Message}`);
    }
  } catch (e: any) {
    console.error(`Search error: ${e.message}`);
  }
}

async function cmdContacts(cfg: DebugConfig) {
  console.log("Fetching contact list...");
  try {
    const data = await api(cfg, "POST", "/Friend/GetContractList", {
      CurrentChatRoomContactSeq: 0,
      CurrentWxcontactSeq: 0,
    });
    if (data.Success && data.Data) {
      const list = data.Data.ContactList?.contactUsernameList ?? [];
      console.log(`Contacts: ${list.length}`);
      for (const c of list.slice(0, 30)) console.log(`  ${c}`);
      if (list.length > 30) console.log(`  ... and ${list.length - 30} more`);
    } else {
      console.log(`Failed: ${data.Message}`);
    }
  } catch (e: any) {
    console.error(`Contact list error: ${e.message}`);
  }
}

async function cmdRecv(cfg: DebugConfig, seconds: number = 60) {
  console.log("Initializing longlink (Newinit)...");
  try {
    const initData = await api(cfg, "POST", "/Login/Newinit");
    if (initData.Success) {
      const wxid = initData.Data?.ModUserInfos?.[0]?.UserName?.string;
      console.log(`Newinit OK${wxid ? ` (wxid=${wxid})` : ""}`);
    } else {
      console.log(`Newinit returned: ${initData.Message} (continuing anyway)`);
    }
  } catch (e: any) {
    console.log(`Newinit failed: ${e.message} (continuing with Sync only)`);
  }

  console.log(`\nPolling for messages (${seconds}s)... Press Ctrl+C to stop.\n`);

  let synckey = "";
  let totalMsgs = 0;
  const endTime = Date.now() + seconds * 1000;

  while (Date.now() < endTime) {
    try {
      const data = await api(cfg, "POST", "/Msg/Sync", { Scene: 0, Synckey: synckey });
      if (!data.Success) {
        console.error(`Sync failed: ${data.Message}`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      if (data.Data?.KeyBuf?.buffer) synckey = data.Data.KeyBuf.buffer;

      const msgs = data.Data?.AddMsgs ?? [];
      for (const m of msgs) {
        // Skip noise
        if (m.MsgType === 51) continue;
        if (m.MsgType === 10002 && !m.Content?.string?.includes("revokemsg")) continue;

        totalMsgs++;
        console.log(`[${timestamp()}] ${summarizeMsg(m)}`);
      }

      // If more data, poll immediately; otherwise wait
      if (data.Data?.ContinueFlag && data.Data.ContinueFlag !== 0) {
        continue;
      }
      await new Promise(r => setTimeout(r, 3000));
    } catch (e: any) {
      console.error(`Poll error: ${e.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log(`\nDone. Total messages: ${totalMsgs}`);
}

async function cmdWebhookSet(cfg: DebugConfig, callbackUrl: string, secret?: string) {
  console.log(`Setting webhook → ${callbackUrl}`);
  try {
    const data = await api(cfg, "POST", "/Webhook/Set", {
      url: callbackUrl,
      secret: secret || "",
      enabled: true,
      messageTypes: ["*"],
      includeSelfMessage: false,
      timeout: 5,
      retryCount: 3,
    });
    console.log(`Success: ${data.Success} (Message: ${data.Message})`);
  } catch (e: any) {
    console.error(`Webhook set failed: ${e.message}`);
  }
}

async function cmdWebhookGet(cfg: DebugConfig) {
  try {
    const data = await api(cfg, "GET", "/Webhook/Get");
    console.log(`Webhook config:\n${pretty(data.Data ?? data)}`);
  } catch (e: any) {
    console.error(`Webhook get failed: ${e.message}`);
  }
}

async function cmdWebhookRemove(cfg: DebugConfig) {
  try {
    const data = await api(cfg, "POST", "/Webhook/Remove");
    console.log(`Success: ${data.Success}`);
  } catch (e: any) {
    console.error(`Webhook remove failed: ${e.message}`);
  }
}

async function cmdWebhookTest(cfg: DebugConfig) {
  try {
    const data = await api(cfg, "POST", "/Webhook/Test", {
      MessageType: "sync_message",
      TestData: {},
    });
    console.log(`Test result:\n${pretty(data)}`);
  } catch (e: any) {
    console.error(`Webhook test failed: ${e.message}`);
  }
}

async function cmdWebhookListen(_cfg: DebugConfig, port: number = 8000, seconds: number = 60) {
  const { createServer } = await import("node:http");

  let msgCount = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", messages: msgCount }));
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const envelope = JSON.parse(body);
        const msgs = envelope.Data?.messages ?? [];
        msgCount += msgs.length;
        console.log(`\n[${timestamp()}] Webhook POST — type=${envelope.MessageType}, wxid=${envelope.Wxid}, ${msgs.length} msg(s)`);

        for (const m of msgs) {
          const from = m.fromUser ?? "?";
          const type = m.msgType;
          let content = m.text || m.rawContent || "";
          if (content.length > 150) content = content.substring(0, 150) + "...";
          content = content.replace(/\n/g, "\\n");
          const nick = m.fromNick ? ` (${m.fromNick})` : "";
          console.log(`  msgType=${type} from=${from}${nick} → ${m.toUser}: ${content}`);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false }));
      }
    });
  });

  server.listen(port, () => {
    console.log(`Webhook listener started on 0.0.0.0:${port}/webhook`);
    console.log(`Listening for ${seconds}s... Press Ctrl+C to stop.\n`);
  });

  await new Promise<void>(resolve => {
    setTimeout(() => {
      server.close();
      console.log(`\nDone. Received ${msgCount} messages total.`);
      resolve();
    }, seconds * 1000);
  });
}

// ── Main ────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);
const cfg = loadConfig();

const commands: Record<string, () => Promise<void>> = {
  status: () => cmdStatus(cfg),
  newinit: () => cmdNewinit(cfg),
  heartbeat: () => cmdHeartbeat(cfg),
  sync: () => cmdSync(cfg, Number(args[0]) || 1),
  ws: () => cmdWs(cfg, Number(args[0]) || 30),
  send: () => {
    if (args.length < 2) {
      console.error("Usage: send <to> <text>");
      process.exit(1);
    }
    return cmdSend(cfg, args[0], args.slice(1).join(" "));
  },
  search: () => {
    if (!args[0]) { console.error("Usage: search <keyword>"); process.exit(1); }
    return cmdSearch(cfg, args[0]);
  },
  contacts: () => cmdContacts(cfg),
  recv: () => cmdRecv(cfg, Number(args[0]) || 60),
  "webhook-set": () => {
    if (!args[0]) { console.error("Usage: webhook-set <url> [secret]"); process.exit(1); }
    return cmdWebhookSet(cfg, args[0], args[1]);
  },
  "webhook-get": () => cmdWebhookGet(cfg),
  "webhook-remove": () => cmdWebhookRemove(cfg),
  "webhook-test": () => cmdWebhookTest(cfg),
  "webhook-listen": () => cmdWebhookListen(cfg, Number(args[0]) || 8000, Number(args[1]) || 60),
};

if (!cmd || !commands[cmd]) {
  console.log(`WCPP MAX Debug CLI

Usage: npx tsx tools/debug.ts <command> [args...]

Commands:
  status              Check server + authcode validity
  newinit             Initialize longlink (/Login/Newinit)
  heartbeat           Send longlink heartbeat
  sync [rounds]       Poll /Msg/Sync (default: 1 round)
  ws [seconds]        Listen on WebSocket (default: 30s)
  send <to> <text>    Send a text message (use UserName, not wxid)
  search <keyword>    Search contacts by WeChat ID / phone
  contacts            List all contacts
  recv [seconds]      Newinit + live sync polling (default: 60s)

Webhook:
  webhook-set <url> [secret]   Register webhook with WCPP MAX
  webhook-get                  Show current webhook config
  webhook-remove               Remove webhook
  webhook-test                 Send test POST to webhook
  webhook-listen [port] [sec]  Start local server to receive webhooks

Config: reads from local-config.json
  { "host": "...", "authcode": "...", "wsUrl": "ws://..." }
`);
  process.exit(cmd ? 1 : 0);
}

commands[cmd]().catch((e) => {
  console.error(e);
  process.exit(1);
});
