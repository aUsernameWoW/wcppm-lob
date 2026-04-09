/**
 * WeChatPadPro / WeChatPadProMAX channel plugin for OpenClaw.
 *
 * Supports both WS (standard WCPP) and HTTP Sync polling (WCPP MAX).
 */

import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { WcppClient, type NormalizedMessage } from "./client.js";

// ──────────────────────────────────────────────
// Account resolution
// ──────────────────────────────────────────────

export interface ResolvedAccount {
  accountId: string | null;
  adminKey: string;
  host: string;
  port: number;
  authKey?: string;
  authcode?: string;
  wxid?: string;
  allowFrom: string[];
  dmPolicy: string | undefined;
  replyWithMention: boolean;
  proxy?: string;
  syncMode: "ws" | "sync";
  syncInterval?: number;
  readOnly?: boolean;
  allowMsgTypes?: number[];
  passRevokemsg?: boolean;
  maxMessageAge?: number;
}

function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedAccount {
  const section = (cfg.channels as Record<string, any>)?.["wechatpadpro"];
  if (!section?.host) {
    throw new Error("wechatpadpro: host is required in config");
  }

  // Determine mode: if authcode is present, default to sync mode
  const syncMode: "ws" | "sync" = section.syncMode ?? (section.authcode ? "sync" : "ws");

  // For sync mode, adminKey isn't required (authcode is used instead)
  if (syncMode === "ws" && !section.adminKey) {
    throw new Error("wechatpadpro: adminKey is required for WS mode");
  }

  return {
    accountId: accountId ?? null,
    adminKey: section.adminKey ?? "",
    host: section.host,
    port: section.port ?? 8062,
    authKey: section.authKey,
    authcode: section.authcode,
    wxid: section.wxid,
    allowFrom: section.allowFrom ?? [],
    dmPolicy: section.dmSecurity,
    replyWithMention: section.replyWithMention ?? false,
    proxy: section.proxy,
    syncMode,
    syncInterval: section.syncInterval,
    readOnly: section.readOnly,
    allowMsgTypes: section.allowMsgTypes,
    passRevokemsg: section.passRevokemsg,
    maxMessageAge: section.maxMessageAge,
  };
}

// ──────────────────────────────────────────────
// The plugin
// ──────────────────────────────────────────────

let client: WcppClient | null = null;

export const wechatpadproPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: createChannelPluginBase({
    id: "wechatpadpro",
    setup: {
      resolveAccount,
      inspectAccount(cfg, _accountId) {
        const section = (cfg.channels as Record<string, any>)?.["wechatpadpro"];
        const hasAuth = section?.adminKey || section?.authcode;
        return {
          enabled: Boolean(section?.host && hasAuth),
          configured: Boolean(section?.host && hasAuth),
          tokenStatus: hasAuth ? "available" : "missing",
        };
      },
    },
  }),

  security: {
    dm: {
      channelKey: "wechatpadpro",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  threading: { topLevelReplyToMode: "reply" },

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
        const fs = await import("fs/promises");
        const buffer = await fs.readFile(params.filePath);
        const base64 = buffer.toString("base64");
        await client.sendImage(params.to, base64);
      },
    },
  },
});

// ──────────────────────────────────────────────
// Runtime lifecycle
// ──────────────────────────────────────────────

export async function startWcppRuntime(
  account: ResolvedAccount,
  log: { info: (...args: any[]) => void; error: (...args: any[]) => void; warn: (...args: any[]) => void; debug: (...args: any[]) => void },
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
      authcode: account.authcode,
      wxid: account.wxid,
      proxy: account.proxy,
      replyWithMention: account.replyWithMention,
      syncMode: account.syncMode,
      syncInterval: account.syncInterval,
      readOnly: account.readOnly,
      allowMsgTypes: account.allowMsgTypes,
      passRevokemsg: account.passRevokemsg,
      maxMessageAge: account.maxMessageAge,
    },
    log as any,
  );

  // Login / verify auth
  const creds = await client.login();
  if (!creds) {
    log.error("WeChatPadPro: login/auth failed, channel will not receive messages");
    return;
  }
  log.info(`WeChatPadPro: authenticated, wxid=${creds.wxid}, mode=${account.syncMode}`);

  // Wire up inbound handler (normalized messages)
  client.onMessage = async (msg: NormalizedMessage) => {
    // Derive sender display name
    let senderName = "";
    if (msg.pushContent) {
      // PushContent format: "Nickname : text" or "Nickname sent you a..."
      const colonIdx = msg.pushContent.indexOf(" : ");
      if (colonIdx > 0) {
        senderName = msg.pushContent.substring(0, colonIdx);
      } else {
        // Fallback: try to extract from push content before "sent you"
        const sentIdx = msg.pushContent.indexOf(" sent ");
        if (sentIdx > 0) {
          senderName = msg.pushContent.substring(0, sentIdx).trim();
        }
      }
    }

    // For group messages, try to get nickname from contact cache
    if (msg.isGroup && !senderName) {
      const contact = client!.getContact(msg.senderWxid);
      if (contact?.NickName?.string) {
        senderName = contact.NickName.string;
      }
    }

    await dispatchInbound({
      channel: "wechatpadpro",
      chatType: msg.isGroup ? "group" : "dm",
      senderId: msg.senderWxid,
      senderName,
      text: msg.text,
      groupId: msg.groupId ?? undefined,
      isAtBot: msg.isAtBot,
      raw: msg.raw,
    });
  };

  // Connect (WS or Sync polling)
  client.connect();

  if (account.readOnly) {
    log.info("WeChatPadPro: read-only mode ON — receiving only, no sending");
  }
  log.info("WeChatPadPro: runtime started, listening for messages");
}

export function stopWcppRuntime(): void {
  client?.disconnect();
  client = null;
}

export function getWcppClient(): WcppClient | null {
  return client;
}
