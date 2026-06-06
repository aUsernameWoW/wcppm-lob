/**
 * main.ts — the wcppm console entrypoint.
 *
 *   npm run console [configPath] [--url ws://host:port] [--token TOKEN]
 *
 * Attaches to the running middleware as a READ-ONLY observer (autoAck:false) so
 * it never steals the real adapter's acks (delivery state is global — see the
 * design spec §2.1). It adds no active WeChat operations.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createBridgeClient } from "../shared/bridge-client.js";
import type { Frame } from "../shared/frame.js";
import { parseCommand, type Command } from "./commands.js";
import { startTerminal } from "./terminal.js";
import {
  initState, applyFrame, applyStatus, setConnected, setFilter, clearFilter,
  clearOverlay, scroll, setInput, setStatusLine, setOverlay, visibleMessages,
  type ConsoleState,
} from "./state.js";

interface ConsoleArgs {
  configPath: string;
  url?: string;
  token?: string;
}

function parseArgs(argv: string[]): ConsoleArgs {
  let configPath = join(homedir(), ".config", "wcppm", "config.json");
  let url: string | undefined;
  let token: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") url = argv[++i];
    else if (a === "--token") token = argv[++i];
    else if (!a.startsWith("--")) configPath = a;
  }
  return { configPath, url, token };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(args.configPath, "utf8")) as Record<string, unknown>;
  const account = (raw.account as string) || "default";
  const token = args.token ?? (raw.bridgeToken as string);
  const port = (raw.bridgePort as number) ?? 8077;
  const url = args.url ?? `ws://127.0.0.1:${port}`;
  if (!token) throw new Error("no bridgeToken (set it in the config or pass --token)");

  let state = initState();
  let terminal: ReturnType<typeof startTerminal> | undefined;
  let pendingForceSync = false;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let healthTimer: ReturnType<typeof setInterval>;

  const update = (next: ConsoleState): void => {
    state = next;
    terminal?.schedulePaint();
  };
  const flash = (line: string): void => {
    update(setStatusLine(state, line));
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => update(setStatusLine(state, "")), 3000);
  };

  const bridge = createBridgeClient({
    url, token, account, autoAck: false,
    onMessage: (frame: Frame) => update(applyFrame(state, frame)),
    onReady: (selfWxid) => update(applyStatus(state, { ...state.status, wsUp: true, selfWxid })),
  });

  async function execute(cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "filter": update(setFilter(state, { ...state.filter, chat: cmd.chat })); return;
      case "grep": update(setFilter(state, { ...state.filter, keyword: cmd.keyword })); return;
      case "dm": update(setFilter(state, { ...state.filter, dmOnly: true })); return;
      case "clear": update(clearFilter(clearOverlay(state))); return;
      case "send": {
        const r = await bridge.send({ to: cmd.to, text: cmd.text });
        flash(r.ok ? `✓ sent${r.msgId ? ` (${r.msgId})` : ""}` : "⚠ send failed");
        return;
      }
      case "reply": {
        const vis = visibleMessages(state);
        const target = vis[vis.length - 1];
        if (!target) { flash("⚠ nothing to reply to"); return; }
        const r = await bridge.send({ to: target.chat.id, text: cmd.text, replyTo: target.id });
        flash(r.ok ? "✓ replied" : "⚠ reply failed");
        return;
      }
      case "forcesync": {
        flash("⚠ forcesync is operator-only — type 'y' to confirm");
        pendingForceSync = true;
        return;
      }
      case "who": {
        const rows = await bridge.getContacts(cmd.query);
        update(setOverlay(state, rows.length
          ? rows.map((c) => `${c.name} · ${c.wxid}${c.type ? ` (${c.type})` : ""}`)
          : ["(no matching contacts)"]));
        return;
      }
      case "history": {
        const frames = await bridge.getHistory({ chat: cmd.chat, limit: cmd.limit });
        update(setOverlay(state, frames.length
          ? frames.map((f) => `${f.from.name ?? f.from.wxid}: ${f.media ? `<${f.media.kind}>` : f.text}`)
          : ["(no history)"]));
        return;
      }
      case "status": {
        const h = await bridge.getHealth();
        flash(`WS ${h.wsUp ? "up" : "down"} · self ${h.selfWxid ?? "?"} · last ${h.lastMsgTs ?? "-"}`);
        return;
      }
      case "help":
        update(setOverlay(state, [
          "commands: /filter <chat> · /grep <kw> · /dm · /clear",
          "send <to> <text> · r <text> · forcesync · who <q> · history <chat> [n]",
          "status · help · quit   (↑↓ scroll · Esc dismiss)",
        ]));
        return;
      case "quit":
        shutdown();
        return;
      case "error":
        flash(`⚠ ${cmd.message}`);
        return;
    }
  }

  function onSubmit(line: string): void {
    const trimmed = line.trim();
    if (pendingForceSync) {
      pendingForceSync = false;
      if (trimmed === "y" || trimmed === "yes") {
        void bridge.forceSync(account).then((r) =>
          flash(r.ok ? `⟳ synced · +${r.messages ?? 0}` : "⚠ forcesync failed"));
      } else {
        flash("forcesync cancelled");
      }
      return;
    }
    if (!trimmed) return;
    void execute(parseCommand(trimmed));
  }

  function shutdown(): void {
    if (statusTimer) clearTimeout(statusTimer);
    clearInterval(healthTimer);
    try { bridge.close(); } catch { /* ignore */ }
    try { terminal?.close(); } catch { /* ignore */ }
    process.exit(0);
  }

  terminal = startTerminal(() => state, {
    onSubmit,
    onScroll: (delta) => update(scroll(state, delta)),
    onInputChange: (input) => update(setInput(state, input)),
    onEscape: () => update(clearOverlay(state)),
    onQuit: shutdown,
  });

  update(setConnected(state, true));
  bridge.connect();

  // Poll /healthz for the header status (~2s).
  healthTimer = setInterval(() => {
    void bridge.getHealth().then((h) =>
      update(applyStatus(state, { wsUp: h.wsUp, selfWxid: h.selfWxid ?? state.status.selfWxid, lastMsgTs: h.lastMsgTs })));
  }, 2000);
  healthTimer.unref?.();

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
