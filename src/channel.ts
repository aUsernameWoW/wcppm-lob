/**
 * WeChatPadPro channel plugin for OpenClaw.
 *
 * Translates between WeChatPadPro's WS/REST API and OpenClaw's channel interface.
 */

import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { WcppClient, type WcppRawMessage, type WcppCredentials } from "./client.js";

// ──────────────────────────────────────────────
// Account resolution
// ──────────────────────────────────────────────

export interface ResolvedAccount {
  accountId: string | null;
  adminKey: string;
  host: string;
  port: number;
  authKey?: string;
  wxid?: string;
  allowFrom: string[];
  dmPolicy: string | undefined;
  replyWithMention: boolean;
  proxy?: string;
}

function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedAccount {
  const section = (cfg.channels as Record<string, any>)?.["wechatpadpro"];
  if (!section?.adminKey || !section?.host) {
    throw new Error(
      "wechatpadpro: adminKey and host are required in config",
    );
  }
  return {
    accountId: accountId ?? null,
    adminKey: section.adminKey,
    host: section.host,
    port: section.port ?? 8080,
    authKey: section.authKey,
    wxid: section.wxid,
    allowFrom: section.allowFrom ?? [],
    dmPolicy: section.dmSecurity,
    replyWithMention: section.replyWithMention ?? false,
    proxy: section.proxy,
  };
}

// ──────────────────────────────────────────────
// Inbound message → OpenClaw shape
// ──────────────────────────────────────────────

interface ParsedInbound {
  chatType: "dm" | "group";
  senderId: string;
  senderNickname: string;
  groupId?: string;
  text: string;
  isAtBot: boolean;
  raw: WcppRawMessage;
}

function parseInboundMessage(
  raw: WcppRawMessage,
  selfWxid: string,
): ParsedInbound | null {
  const fromUser = raw.from_user_name?.str ?? "";
  const content = raw.content?.str ?? "";
  const pushContent = raw.push_content ?? "";
  const msgSource = raw.msg_source ?? "";

  // Ignore own messages
  if (fromUser === selfWxid) return null;

  // Ignore system accounts
  if (["weixin", "newsapp", "newsapp_wechat"].includes(fromUser)) return null;

  // Ignore messages older than 3 minutes
  if (Date.now() / 1000 - raw.create_time > 180) return null;

  const isGroup = fromUser.includes("@chatroom");
  let senderId: string;
  let senderNickname = "";
  let groupId: string | undefined;
  let text = content;
  let isAtBot = false;

  if (isGroup) {
    groupId = fromUser;
    // Group message format: "sender_wxid:\nactual message"
    const parts = content.split(":\n", 1);
    senderId = parts.length === 2 ? parts[0] : "";
    text = parts.length === 2 ? parts[1] : content;

    // Check @bot
    if (
      msgSource.includes(`<atuserlist>${selfWxid}</atuserlist>`) ||
      msgSource.includes(`<atuserlist>${selfWxid},`) ||
      msgSource.includes(`,${selfWxid}</atuserlist>`) ||
      pushContent.includes("在群聊中@了你")
    ) {
      isAtBot = true;
    }
  } else {
    senderId = fromUser;
    // Private message nickname from push_content: "Nickname : content"
    if (pushContent && pushContent.includes(" : ")) {
      senderNickname = pushContent.split(" : ")[0];
    }
  }

  return {
    chatType: isGroup ? "group" : "dm",
    senderId,
    senderNickname,
    groupId,
    text,
    isAtBot,
    raw,
  };
}

// ──────────────────────────────────────────────
// The plugin
// ──────────────────────────────────────────────

// Singleton client per process
let client: WcppClient | null = null;

export const wechatpadproPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: createChannelPluginBase({
    id: "wechatpadpro",
    setup: {
      resolveAccount,
      inspectAccount(cfg, _accountId) {
        const section = (cfg.channels as Record<string, any>)?.["wechatpadpro"];
        return {
          enabled: Boolean(section?.adminKey && section?.host),
          configured: Boolean(section?.adminKey && section?.host),
          tokenStatus: section?.adminKey ? "available" : "missing",
        };
      },
    },
  }),

  // DM security
  security: {
    dm: {
      channelKey: "wechatpadpro",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  // Threading
  threading: { topLevelReplyToMode: "reply" },

  // Outbound
  outbound: {
    attachedResults: {
      sendText: async (params) => {
        if (!client) throw new Error("WeChatPadPro client not initialized");
        const ok = await client.sendText(params.to, params.text);
        return { messageId: ok ? `wcpp-${Date.now()}` : undefined };
      },
    },
    base: {
      sendMedia: async (params) => {
        if (!client) throw new Error("WeChatPadPro client not initialized");
        // For now handle image; can extend for other media types
        const fs = await import("fs/promises");
        const buffer = await fs.readFile(params.filePath);
        const base64 = buffer.toString("base64");
        await client.sendImage(params.to, base64);
      },
    },
  },
});

// ──────────────────────────────────────────────
// Runtime lifecycle — called from entry point
// ──────────────────────────────────────────────

export async function startWcppRuntime(
  account: ResolvedAccount,
  log: { info: (...args: any[]) => void; error: (...args: any[]) => void; warn: (...args: any[]) => void },
  dispatchInbound: (msg: {
    channel: string;
    chatType: "dm" | "group";
    senderId: string;
    senderName: string;
    text: string;
    groupId?: string;
    isAtBot: boolean;
    raw: any;
  }) => Promise<void>,
): Promise<void> {
  client = new WcppClient(
    {
      adminKey: account.adminKey,
      host: account.host,
      port: account.port,
      authKey: account.authKey,
      wxid: account.wxid,
      proxy: account.proxy,
      replyWithMention: account.replyWithMention,
    },
    log as any,
  );

  // Login
  const creds = await client.login();
  if (!creds) {
    log.error("WeChatPadPro: login failed, channel will not receive messages");
    return;
  }

  // Persist credentials back to config
  // (The entry point / gateway should handle config persistence)

  // Wire up inbound handler
  client.onMessage = async (raw: WcppRawMessage) => {
    if (!client?.wxid) return;
    const parsed = parseInboundMessage(raw, client.wxid);
    if (!parsed) return;

    await dispatchInbound({
      channel: "wechatpadpro",
      chatType: parsed.chatType,
      senderId: parsed.senderId,
      senderName: parsed.senderNickname,
      text: parsed.text,
      groupId: parsed.groupId,
      isAtBot: parsed.isAtBot,
      raw: parsed.raw,
    });
  };

  // Connect WebSocket
  client.connectWebSocket();
  log.info("WeChatPadPro: runtime started, listening for messages");
}

export function stopWcppRuntime(): void {
  client?.disconnectWebSocket();
  client = null;
}

export function getWcppClient(): WcppClient | null {
  return client;
}
