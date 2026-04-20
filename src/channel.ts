/**
 * WeChatPadProMax channel plugin for OpenClaw.
 *
 * Base inbound transport is WebSocket push (/ws/sync). Webhook can be
 * enabled as an additional inbound channel; dedup by MsgId handles the
 * double-delivery.
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
  host: string;
  port: number;
  authcode?: string;
  wxid?: string;
  allowFrom: string[];
  dmPolicy: string | undefined;
  replyWithMention: boolean;
  proxy?: string;
  wsUrl?: string;
  webhookEnabled?: boolean;
  readOnly?: boolean;
  allowMsgTypes?: number[];
  passRevokemsg?: boolean;
  maxMessageAge?: number;
  webhookHost?: string;
  webhookPort?: number;
  webhookPath?: string;
  webhookSecret?: string;
  webhookUrl?: string;
  webhookDebug?: boolean;
  webhookSilentDropUnsigned?: boolean;
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

  return {
    accountId: accountId ?? null,
    host: section.host,
    port: section.port ?? 8062,
    authcode: section.authcode,
    wxid: section.wxid,
    allowFrom: section.allowFrom ?? [],
    dmPolicy: section.dmSecurity,
    replyWithMention: section.replyWithMention ?? false,
    proxy: section.proxy,
    wsUrl: section.wsUrl,
    webhookEnabled: section.webhookEnabled === true,
    readOnly: section.readOnly,
    allowMsgTypes: section.allowMsgTypes,
    passRevokemsg: section.passRevokemsg,
    maxMessageAge: section.maxMessageAge,
    webhookHost: section.webhookHost,
    webhookPort: section.webhookPort,
    webhookPath: section.webhookPath,
    webhookSecret: section.webhookSecret,
    webhookUrl: section.webhookUrl,
    webhookDebug: section.webhookDebug,
    webhookSilentDropUnsigned: section.webhookSilentDropUnsigned,
  };
}

// ──────────────────────────────────────────────
// The plugin
// ──────────────────────────────────────────────

let client: WcppClient | null = null;

function inspectAccount(cfg: OpenClawConfig, _accountId?: string | null) {
  const section = readSection(cfg);
  const hasAuth = Boolean(section?.authcode);
  // Active mode (host set): needs authcode. Passive webhook-only (no host):
  // needs webhookEnabled. Anything else is not configured.
  const configured =
    (Boolean(section?.host) && hasAuth) ||
    (!section?.host && section?.webhookEnabled === true);
  return {
    enabled: configured && section?.enabled !== false,
    configured,
    tokenStatus: hasAuth ? "available" : "missing",
  };
}

function isConfigured(account: ResolvedAccount | undefined): boolean {
  if (!account) return false;
  if (account.host) return Boolean(account.authcode);
  // No host → must be passive webhook-only.
  return account.webhookEnabled === true;
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
  isEnabled(_account: ResolvedAccount, cfg: OpenClawConfig): boolean {
    // "Is this account enabled in config?" — answered purely from the config section.
    // Config completeness is the separate concern of `isConfigured`. We must NOT
    // call `isConfigured(account)` here because the gateway sometimes invokes
    // isEnabled with a stub account (no host / no webhookEnabled) during introspection paths,
    // and that stub would falsely report unconfigured → disabled → channel never starts.
    const section = readSection(cfg);
    if (!section) return false;
    return section.enabled !== false;
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

// `createChannelPluginBase` does NOT pass `gateway` through to its result (its
// spread list only includes id/meta/setup/config/capabilities/etc.). If we put
// `gateway` inside the helper call, `plugin.gateway` ends up undefined — the
// gateway then short-circuits at `if (!startAccount) return` and silently
// never starts our channel. Attach `gateway` directly onto the base object,
// mirroring how `extensions/twitch/src/plugin.ts` structures it inline.
const wechatpadproBase = {
  ...createChannelPluginBase({
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
  }),
  gateway: {
      startAccount: async (ctx: any) => {
        const account = ctx.account as ResolvedAccount;
        if (!isConfigured(account)) {
          ctx.log?.warn?.(
            "wechatpadpro: account not fully configured, skipping start (need host + authcode, or webhookEnabled for passive mode)",
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
};

export const wechatpadproPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: wechatpadproBase as any,

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
      host: account.host,
      port: account.port,
      authcode: account.authcode,
      wxid: account.wxid,
      proxy: account.proxy,
      replyWithMention: account.replyWithMention,
      wsUrl: account.wsUrl,
      webhookEnabled: account.webhookEnabled,
      readOnly: account.readOnly,
      allowMsgTypes: account.allowMsgTypes,
      passRevokemsg: account.passRevokemsg,
      maxMessageAge: account.maxMessageAge,
      webhookHost: account.webhookHost,
      webhookPort: account.webhookPort,
      webhookPath: account.webhookPath,
      webhookSecret: account.webhookSecret,
      webhookUrl: account.webhookUrl,
      webhookDebug: account.webhookDebug,
      webhookSilentDropUnsigned: account.webhookSilentDropUnsigned,
    },
    log as any,
  );

  const creds = await client.login();
  if (!creds) {
    log.error("WeChatPadPro: login/auth failed, channel will not receive messages");
    return;
  }
  const transports = [
    account.host ? "websocket" : null,
    account.webhookEnabled ? "webhook" : null,
  ].filter(Boolean).join("+") || "none";
  log.info(`WeChatPadPro: authenticated, wxid=${creds.wxid}, transports=${transports}`);

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
