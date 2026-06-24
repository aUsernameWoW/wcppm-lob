/**
 * WeChatPadProMax channel plugin for OpenClaw — THIN ADAPTER.
 *
 * The WeChat transport (WS/webhook/Sync, dedup, normalize, media, send) lives
 * in the standalone middleware process. This plugin is a thin client: it
 * subscribes to the middleware over WebSocket for inbound frames and POSTs
 * outbound sends. OpenClaw restarting no longer tears down the WeChat session.
 *
 * What stays here (downstream / app concerns): the agent reply pipeline
 * (dispatch.ts) and the DM access gate (buildDmAuthorizer, backed by
 * ctx.runtime's pairing store).
 */

import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
  createPreCryptoDirectDmAuthorizer,
  resolveInboundDirectDmAccessWithRuntime,
} from "openclaw/plugin-sdk/direct-dm-access";
import type { Frame } from "../../shared/frame.js";
import { createBridgeClient, type BridgeClient } from "../../shared/bridge-client.js";
import { dispatchInboundToOpenClaw, type WcppDmAuthorizer } from "./dispatch.js";
import { evaluateInboundFrame } from "./gate.js";
import {
  DEFAULT_ACCOUNT_ID,
  isConfigured,
  listAccountIds,
  readSection,
  resolveAccount,
  type ResolvedAccount,
} from "./account-config.js";

export type { ResolvedAccount } from "./account-config.js";

// ──────────────────────────────────────────────
// The plugin
// ──────────────────────────────────────────────

// One bridge connection per OpenClaw accountId (each subscribes to the middleware
// as its own account). Replaces the former single-connection module global.
const bridges = new Map<string, BridgeClient>();

function inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
  const account = resolveAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
  const hasToken = Boolean(account.bridgeToken);
  // Configured = we can reach the middleware: bridgeUrl + bridgeToken.
  const configured = Boolean(account.bridgeUrl) && hasToken;
  const section = readSection(cfg);
  return {
    enabled: configured && section?.enabled !== false,
    configured,
    tokenStatus: hasToken ? "available" : "missing",
  };
}

const wechatpadproConfigAdapter = {
  listAccountIds(cfg: OpenClawConfig): string[] {
    return listAccountIds(cfg);
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
    // isEnabled with a stub account during introspection paths, and that stub
    // would falsely report unconfigured → disabled → channel never starts.
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

// `createChannelPluginBase` does NOT pass `gateway` through to its result, so we
// attach `gateway` directly onto the base object (mirroring twitch's plugin.ts).
// Putting it inside the helper call makes `plugin.gateway` undefined and the
// gateway silently never starts our channel.
const wechatpadproBase = {
  ...createChannelPluginBase({
    id: "wechatpadpro",
    meta: {
      id: "wechatpadpro",
      label: "WeChatPadPro",
      selectionLabel: "WeChat (via WeChatPadPro)",
      blurb: "Connect OpenClaw to WeChat via the WeChatPadPro middleware (iPad protocol).",
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
          "wechatpadpro: account not fully configured, skipping start (need bridgeUrl + bridgeToken)",
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
          sendText: async (to: string, text: string) => {
            const b = bridges.get(ctx.accountId);
            return b ? (await b.send({ to, text })).ok : false;
          },
          sendQuote: async (to: string, text: string, quoteMsgId: string) => {
            const b = bridges.get(ctx.accountId);
            return b ? (await b.send({ to, text, replyTo: quoteMsgId })).ok : false;
          },
        },
        authorizeDm: buildDmAuthorizer({
          runtime: ctx.runtime,
          cfg: ctx.cfg,
          accountId: ctx.accountId,
          dmPolicy: account.dmPolicy,
          allowFrom: account.allowFrom,
          log,
        }),
        fetchMedia: (id: string) => {
          const b = bridges.get(ctx.accountId);
          return b ? b.fetchMedia(id, account.account) : Promise.resolve(null);
        },
      };
      startWcppRuntime(ctx.accountId, account, log, async (msg) => {
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
          mediaKind: msg.mediaKind,
        });
      });

      // OpenClaw treats startAccount as a long-running task: the moment this
      // returns, the gateway flips `running: false`. Block until aborted, then
      // tear down the bridge connection.
      await new Promise<void>((resolve) => {
        const sig: AbortSignal | undefined = ctx.abortSignal;
        if (!sig) return; // no signal: stay alive; stopAccount handles teardown
        if (sig.aborted) {
          resolve();
          return;
        }
        sig.addEventListener("abort", () => resolve(), { once: true });
      });
      stopWcppRuntime(ctx.accountId);
    },
    stopAccount: async (ctx: any) => {
      stopWcppRuntime(ctx.accountId);
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
        const b = bridges.get((params as any).accountId ?? DEFAULT_ACCOUNT_ID);
        if (!b) throw new Error("WeChatPadPro bridge not connected");
        const ok = params.reply_to
          ? (await b.send({ to: params.to, text: params.text, replyTo: params.reply_to })).ok
          : (await b.send({ to: params.to, text: params.text })).ok;
        return { messageId: ok ? `wcpp-${Date.now()}` : undefined };
      },
    },
    base: {
      sendMedia: async () => {
        // Outbound media is not yet supported over the bridge (middleware /send
        // is text-only). Add a middleware /sendMedia endpoint to enable this.
        throw new Error("WeChatPadPro: media send not supported via the bridge yet");
      },
    },
  },
});

// ──────────────────────────────────────────────
// DM policy gate
// ──────────────────────────────────────────────

/**
 * Build a DM authorizer bound to the current account + runtime. Turns
 * `dmSecurity` from a metadata field into an actual inbound gate: it runs
 * before the agent pipeline, sends a pairing challenge on first contact when
 * `dmSecurity: "pairing"`, and drops non-allowlisted senders on
 * `"allowlist"` / `"disabled"`.
 *
 * Returns undefined when `runtime` is missing (older gateway, tests) so the
 * dispatch side can fall through to "accept everything".
 */
function buildDmAuthorizer(params: {
  runtime: any;
  cfg: any;
  accountId: string;
  dmPolicy: string | undefined;
  allowFrom: string[];
  log: { info: (...args: any[]) => void; warn: (...args: any[]) => void; debug: (...args: any[]) => void };
}): WcppDmAuthorizer | undefined {
  const { runtime, cfg, accountId, dmPolicy, allowFrom, log } = params;
  if (!runtime) return undefined;

  const pairing = createChannelPairingController({
    core: runtime,
    channel: "wechatpadpro",
    accountId,
  });

  const commands = runtime?.channel?.commands;
  const commandRuntime = {
    shouldComputeCommandAuthorized:
      commands?.shouldComputeCommandAuthorized ?? ((_body: string, _cfg: any) => false),
    resolveCommandAuthorizedFromAuthorizers:
      commands?.resolveCommandAuthorizedFromAuthorizers ?? ((_p: any) => false),
  };

  const resolveAccess = (senderId: string) =>
    resolveInboundDirectDmAccessWithRuntime({
      cfg,
      channel: "wechatpadpro",
      accountId,
      dmPolicy,
      allowFrom,
      senderId,
      rawBody: "",
      // WeChat wxids are opaque — exact match, plus "*" wildcard.
      isSenderAllowed: (sender, list) =>
        list.some((entry) => entry === "*" || entry === sender),
      runtime: commandRuntime,
    });

  return createPreCryptoDirectDmAuthorizer({
    resolveAccess,
    issuePairingChallenge: async ({ senderId, reply }) => {
      await pairing.issueChallenge({
        senderId,
        senderIdLine: `Your WeChat ID: ${senderId}`,
        sendPairingReply: reply,
        onCreated: ({ code }) =>
          log.info(`wechatpadpro: pairing challenge issued for ${senderId} (code=${code})`),
        onReplyError: (err) =>
          log.warn(`wechatpadpro: pairing reply send failed for ${senderId}: ${String(err)}`),
      });
    },
    onBlocked: ({ senderId, reason }) =>
      log.debug(`wechatpadpro: blocked DM from ${senderId} (${reason})`),
  });
}

// ──────────────────────────────────────────────
// Runtime lifecycle (bridge connection)
// ──────────────────────────────────────────────

export function startWcppRuntime(
  accountId: string,
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
    mediaKind?: "image" | "voice" | "video";
    raw: any;
  }) => Promise<void>,
): void {
  let selfWxid: string | null = null;
  const bridge = createBridgeClient({
    url: account.bridgeUrl,
    token: account.bridgeToken!,
    account: account.account,
    log,
    onReady: (wxid) => {
      selfWxid = wxid || null;
      log.info(`WeChatPadPro: bridge ready (selfWxid=${selfWxid ?? "unknown"})`);
    },
    onMessage: (frame: Frame) => {
      // Token-burn gate, BEFORE the agent pipeline: drop our own echoed
      // messages and messages from non-allowlisted groups (the DM gate in
      // dispatch.ts covers DMs only).
      const verdict = evaluateInboundFrame(frame, {
        selfWxid,
        groupAllowFrom: account.groupAllowFrom,
      });
      if (verdict.action === "drop") {
        log.debug(
          `wechatpadpro: dropped frame ${frame.id} from ${frame.chat.id} (${verdict.reason})`,
        );
        return;
      }
      // Append quote context as a suffix, matching the QQ/Telegram convention.
      let bodyText = frame.text;
      if (frame.quote) {
        const label = frame.quote.senderName || frame.quote.senderWxid || "unknown";
        bodyText += `\n\n[Replying to ${label}]\n${frame.quote.summary ?? ""}\n[/Replying]`;
      }
      dispatchInbound({
        channel: "wechatpadpro",
        chatType: frame.chatType === "group" ? "group" : "dm",
        senderId: frame.from.wxid,
        senderName: frame.from.name ?? "",
        text: bodyText,
        groupId: frame.chatType === "group" ? frame.chat.id : undefined,
        isAtBot: frame.mentionedMe,
        ...(frame.media && { mediaKind: frame.media.kind }),
        ...(frame.quote && {
          replyToId: frame.quote.id,
          replyToBody: frame.quote.summary,
          replyToSender: frame.quote.senderName || frame.quote.senderWxid,
        }),
        // startAccount reads msgId from raw.normalized.msgId.
        raw: { frame, normalized: { msgId: frame.id } },
      }).catch((err) => log.error(`wechatpadpro: dispatch failed: ${String(err)}`));
    },
  });

  bridges.set(accountId, bridge);
  bridge.connect();
  log.info(
    `WeChatPadPro: bridge runtime started → ${account.bridgeUrl} (accountId=${accountId}, account=${account.account})`,
  );
}

export function stopWcppRuntime(accountId: string): void {
  const bridge = bridges.get(accountId);
  bridge?.close();
  bridges.delete(accountId);
}

/**
 * Look up a running bridge by accountId. With the accountId omitted it returns
 * the sole bridge when exactly one is running (operator convenience / single-account).
 */
export function getBridgeClient(accountId?: string): BridgeClient | null {
  if (accountId) return bridges.get(accountId) ?? null;
  return bridges.size === 1 ? bridges.values().next().value ?? null : null;
}
