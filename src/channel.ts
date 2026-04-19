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
import { dispatchInboundToOpenClaw } from "./dispatch.js";

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
  syncMode: "ws" | "sync" | "websocket" | "webhook";
  wsUrl?: string;
  syncInterval?: number;
  readOnly?: boolean;
  allowMsgTypes?: number[];
  passRevokemsg?: boolean;
  maxMessageAge?: number;
  newinitOnStart?: boolean;
  wsFallbackThreshold?: number;
  webhookHost?: string;
  webhookPort?: number;
  webhookPath?: string;
  webhookSecret?: string;
  webhookUrl?: string;
}

const DEFAULT_ACCOUNT_ID = "default";

function readSection(cfg: OpenClawConfig): Record<string, any> | undefined {
  return (cfg.channels as Record<string, any>)?.["wechatpadpro"];
}

function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedAccount {
  const section = readSection(cfg) ?? {};

  // Mode + validation are best-effort here so the gateway can still introspect
  // the channel before the user has finished filling in the web UI form.
  const syncMode: "ws" | "sync" | "websocket" | "webhook" =
    section.syncMode ?? (section.authcode ? "sync" : "ws");

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
    wsUrl: section.wsUrl,
    syncInterval: section.syncInterval,
    readOnly: section.readOnly,
    allowMsgTypes: section.allowMsgTypes,
    passRevokemsg: section.passRevokemsg,
    maxMessageAge: section.maxMessageAge,
    newinitOnStart: section.newinitOnStart,
    wsFallbackThreshold: section.wsFallbackThreshold,
    webhookHost: section.webhookHost,
    webhookPort: section.webhookPort,
    webhookPath: section.webhookPath,
    webhookSecret: section.webhookSecret,
    webhookUrl: section.webhookUrl,
  };
}

// ──────────────────────────────────────────────
// The plugin
// ──────────────────────────────────────────────

let client: WcppClient | null = null;

function inspectAccount(cfg: OpenClawConfig, _accountId?: string | null) {
  const section = readSection(cfg);
  const hasAuth = section?.adminKey || section?.authcode;
  const isWebhook = section?.syncMode === "webhook";
  // Webhook is a passive receiver — even without host/authcode it can listen
  // and process pushes (registration + Newinit are the operator's responsibility).
  const configured = isWebhook ? true : Boolean(section?.host && hasAuth);
  return {
    enabled: configured && section?.enabled !== false,
    configured,
    tokenStatus: hasAuth ? "available" : "missing",
  };
}

function isConfigured(account: ResolvedAccount | undefined): boolean {
  if (!account) return false;
  if (account.syncMode === "webhook") return true;
  if (!account.host) return false;
  if (account.syncMode === "ws") return Boolean(account.adminKey);
  return Boolean(account.authcode);
}

const wechatpadproConfigAdapter = {
  listAccountIds(cfg: OpenClawConfig): string[] {
    return readSection(cfg) ? [DEFAULT_ACCOUNT_ID] : [];
  },
  resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount {
    return resolveAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
  },
  defaultAccountId(_cfg: OpenClawConfig): string {
    return DEFAULT_ACCOUNT_ID;
  },
  inspectAccount,
  isConfigured(account: ResolvedAccount): boolean {
    return isConfigured(account);
  },
  isEnabled(account: ResolvedAccount, cfg: OpenClawConfig): boolean {
    const section = readSection(cfg);
    if (section?.enabled === false) return false;
    return isConfigured(account);
  },
  describeAccount(account: ResolvedAccount) {
    return {
      accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
      enabled: isConfigured(account),
      configured: isConfigured(account),
    };
  },
  setAccountEnabled({ cfg, enabled }: { cfg: OpenClawConfig; accountId: string; enabled: boolean }) {
    const section = (cfg.channels as Record<string, any>)?.["wechatpadpro"];
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        wechatpadpro: { ...section, enabled },
      },
    } as OpenClawConfig;
  },
  deleteAccount({ cfg }: { cfg: OpenClawConfig; accountId: string }) {
    const next = { ...(cfg.channels as Record<string, any>) };
    delete next.wechatpadpro;
    return { ...cfg, channels: next } as OpenClawConfig;
  },
  resolveAllowFrom({ cfg }: { cfg: OpenClawConfig; accountId?: string | null }): string[] {
    const section = readSection(cfg);
    return (section?.allowFrom ?? []).map((v: unknown) => String(v));
  },
  formatAllowFrom({ allowFrom }: { allowFrom: Array<string | number> }): string[] {
    return allowFrom.map((v) => String(v).trim()).filter(Boolean);
  },
};

export const wechatpadproPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: createChannelPluginBase({
    id: "wechatpadpro",
    meta: {
      id: "wechatpadpro",
      label: "WeChatPadPro",
      selectionLabel: "WeChat (via WeChatPadPro)",
      blurb: "Connect OpenClaw to WeChat using WeChatPadPro / WeChatPadProMax (iPad protocol).",
    },
    capabilities: { chatTypes: ["dm", "group"] },
    config: wechatpadproConfigAdapter,
    setup: {
      resolveAccountId: ({ accountId }: { accountId?: string | null }) =>
        accountId?.trim() || DEFAULT_ACCOUNT_ID,
      applyAccountConfig: ({ cfg }: { cfg: OpenClawConfig }) => {
        const section = (cfg.channels as Record<string, any>)?.["wechatpadpro"];
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            wechatpadpro: { ...section, enabled: true },
          },
        } as OpenClawConfig;
      },
    },
    gateway: {
      startAccount: async (ctx: any) => {
        const account = ctx.account as ResolvedAccount;
        if (!isConfigured(account)) {
          ctx.log?.warn?.(
            "wechatpadpro: account not fully configured, skipping start (need host + adminKey or authcode)",
          );
          return;
        }
        ctx.setStatus?.({
          accountId: ctx.accountId,
          running: true,
          lastStartAt: Date.now(),
          lastError: null,
        });
        const log = (ctx.log ?? console) as any;
        const dispatchCtx = {
          accountId: ctx.accountId,
          log,
          send: {
            sendText: async (to: string, text: string) =>
              client ? await client.sendText(to, text) : false,
            sendQuote: async (to: string, text: string, quoteMsgId: string) =>
              client ? await client.sendQuote(to, text, quoteMsgId) : false,
          },
        };
        await startWcppRuntime(account, log, async (msg) => {
          await dispatchInboundToOpenClaw(dispatchCtx, {
            chatType: msg.chatType,
            conversationId: msg.groupId || msg.senderId,
            senderWxid: msg.senderId,
            senderName: msg.senderName,
            text: msg.text,
            msgId: msg.raw?.normalized?.msgId ?? `wcpp-${Date.now()}`,
            isAtBot: msg.isAtBot,
            replyToBody: msg.replyToBody,
            replyToSender: msg.replyToSender,
          });
        });

        // OpenClaw treats startAccount as a long-running task: the moment this
        // returns, the gateway flips `running: false` in its `finally`, even though
        // our HTTP listener / WS / Sync loop is happily running in the background.
        // Block here until the gateway aborts us, then clean up.
        await new Promise<void>((resolve) => {
          const sig: AbortSignal | undefined = ctx.abortSignal;
          if (!sig) return; // no signal: stay alive forever; stopAccount handles teardown
          if (sig.aborted) { resolve(); return; }
          sig.addEventListener("abort", () => resolve(), { once: true });
        });
        stopWcppRuntime();
      },
      stopAccount: async (ctx: any) => {
        stopWcppRuntime();
        ctx.setStatus?.({
          accountId: ctx.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
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
        
        // Handle reply/quote messages
        if (params.reply_to) {
          const ok = await client.sendQuote(params.to, params.text, params.reply_to);
          return { messageId: ok ? `wcpp-${Date.now()}` : undefined };
        }
        
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
    replyToId?: string;
    replyToBody?: string;
    replyToSender?: string;
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
      wsUrl: account.wsUrl,
      syncInterval: account.syncInterval,
      readOnly: account.readOnly,
      allowMsgTypes: account.allowMsgTypes,
      passRevokemsg: account.passRevokemsg,
      maxMessageAge: account.maxMessageAge,
      newinitOnStart: account.newinitOnStart,
      wsFallbackThreshold: account.wsFallbackThreshold,
      webhookHost: account.webhookHost,
      webhookPort: account.webhookPort,
      webhookPath: account.webhookPath,
      webhookSecret: account.webhookSecret,
      webhookUrl: account.webhookUrl,
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
    const resolvedMedia = client!.resolveMedia(msg);

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

    const rawEnvelope = {
      platform: msg.raw,
      normalized: {
        msgId: msg.msgId,
        fromUser: msg.fromUser,
        toUser: msg.toUser,
        msgType: msg.msgType,
        content: msg.content,
        pushContent: msg.pushContent,
        msgSource: msg.msgSource,
        createTime: msg.createTime,
        senderWxid: msg.senderWxid,
        text: msg.text,
        isGroup: msg.isGroup,
        groupId: msg.groupId,
        isAtBot: msg.isAtBot,
        quote: msg.quote,
      },
      media: resolvedMedia
        ? {
            kind: resolvedMedia.kind,
            info: resolvedMedia.info,
            attachment: resolvedMedia.attachment,
          }
        : null,
    };

    // Build body text — append reply context suffix if this is a quote message
    // Following the QQ/Telegram convention: [Replying to SenderName]\nContent\n[/Replying]
    let bodyText = msg.text;
    if (msg.quote) {
      const replyLabel = msg.quote.referDisplayName || msg.quote.referSenderWxid || "unknown";
      bodyText += `\n\n[Replying to ${replyLabel}]\n${msg.quote.referSummary}\n[/Replying]`;
    }

    await dispatchInbound({
      channel: "wechatpadpro",
      chatType: msg.isGroup ? "group" : "dm",
      senderId: msg.senderWxid,
      senderName,
      text: bodyText,
      groupId: msg.groupId ?? undefined,
      isAtBot: msg.isAtBot,
      ...(msg.quote && {
        replyToId: msg.quote.referMsgId,
        replyToBody: msg.quote.referSummary,
        replyToSender: msg.quote.referDisplayName || msg.quote.referSenderWxid,
      }),
      raw: rawEnvelope,
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
