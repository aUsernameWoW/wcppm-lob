/**
 * Inbound message dispatch into OpenClaw's auto-reply pipeline.
 *
 * Pipeline: NormalizedMessage → MsgContext → finalizeInboundContext →
 *   resolveAgentRoute → createChannelReplyPipeline →
 *   createReplyDispatcherWithTyping → dispatchInboundMessage.
 *
 * Replies come back through the `deliver` callback we hand to the dispatcher;
 * for v1 we map ReplyPayload.text → client.sendText (or sendQuote when the
 * agent emits a replyToId), and ignore media/interactive/btw payloads.
 */

import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { DirectDmDecision } from "openclaw/plugin-sdk/direct-dm-access";
import {
  createReplyDispatcherWithTyping,
  dispatchInboundMessage,
  finalizeInboundContext,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";

const CHANNEL_ID = "wechatpadpro";

export type WcppLogger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
  warn: (msg: string) => void;
  debug: (msg: string) => void;
};

export type WcppSendApi = {
  sendText: (toWxid: string, text: string) => Promise<boolean>;
  sendQuote: (toWxid: string, text: string, quoteMsgId: string) => Promise<boolean>;
};

export type WcppDmAuthorizer = (input: {
  senderId: string;
  reply: (text: string) => Promise<void>;
}) => Promise<DirectDmDecision>;

export type WcppDispatchContext = {
  accountId: string;
  log: WcppLogger;
  send: WcppSendApi;
  /**
   * Inbound DM gate. Built from `dmSecurity` + `allowFrom` in channel.ts,
   * backed by the framework's pairing store. Absent when the host didn't
   * supply a `runtime` handle (older gateway / tests) — falls through to
   * "allow everything" so DMs don't silently vanish.
   */
  authorizeDm?: WcppDmAuthorizer;
};

export type WcppInboundMessage = {
  chatType: "dm" | "group";
  /** wxid we send the reply back to: groupId for groups, senderWxid for DMs. */
  conversationId: string;
  senderWxid: string;
  senderName: string;
  text: string;
  msgId: string;
  isAtBot: boolean;
  replyToBody?: string;
  replyToSender?: string;
};

function buildFromTag(msg: WcppInboundMessage): string {
  return msg.chatType === "group"
    ? `group:${msg.conversationId}`
    : `${CHANNEL_ID}:${msg.senderWxid}`;
}

export async function dispatchInboundToOpenClaw(
  ctx: WcppDispatchContext,
  msg: WcppInboundMessage,
): Promise<void> {
  // DM gate: enforce dmSecurity before the message hits the agent pipeline.
  // On "pairing", the authorizer has already sent a challenge via sendText;
  // on "block", we drop silently. Groups bypass this entirely.
  if (msg.chatType === "dm" && ctx.authorizeDm) {
    const reply = async (text: string) => {
      try {
        await ctx.send.sendText(msg.senderWxid, text);
      } catch (err) {
        ctx.log.warn(`wechatpadpro: pairing reply to ${msg.senderWxid} failed: ${String(err)}`);
      }
    };
    const decision = await ctx.authorizeDm({ senderId: msg.senderWxid, reply });
    if (decision !== "allow") {
      ctx.log.debug(
        `wechatpadpro: DM from ${msg.senderWxid} → ${decision} (skipping agent dispatch)`,
      );
      return;
    }
  }

  const cfg = loadConfig();

  let route: ReturnType<typeof resolveAgentRoute>;
  try {
    route = resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId: ctx.accountId,
      peer: { kind: msg.chatType === "group" ? "group" : "direct", id: msg.conversationId },
    });
  } catch (err) {
    ctx.log.error(`wechatpadpro: resolveAgentRoute failed: ${String(err)}`);
    return;
  }

  const fromTag = buildFromTag(msg);

  const ctxPayload = finalizeInboundContext({
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: msg.conversationId,
    ChatType: msg.chatType === "group" ? "group" : "direct",
    From: fromTag,
    To: msg.conversationId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    SenderId: msg.senderWxid,
    SenderName: msg.senderName || msg.senderWxid,
    MessageSid: msg.msgId,
    Body: msg.text,
    BodyForAgent: msg.text,
    RawBody: msg.text,
    BodyForCommands: msg.text,
    WasMentioned: msg.chatType === "group" ? msg.isAtBot : undefined,
    ReplyToBody: msg.replyToBody,
    ReplyToSender: msg.replyToSender,
    Timestamp: Math.floor(Date.now() / 1000),
  });

  const replyPipeline = createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: route.accountId,
  });

  const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
    createReplyDispatcherWithTyping({
      ...replyPipeline,
      deliver: async (payload: ReplyPayload, info) => {
        const text = (payload.text ?? "").trim();
        if (!text) return;
        const target = msg.conversationId;
        // Quote-reply when the agent flagged a reply target. We use the inbound
        // msgId as the quote target — the agent rarely surfaces a different one
        // and per-channel reply_to mapping is out of scope for v1.
        const quoteId = payload.replyToId || (payload.replyToTag ? msg.msgId : undefined);
        try {
          const ok = quoteId
            ? await ctx.send.sendQuote(target, text, quoteId)
            : await ctx.send.sendText(target, text);
          if (!ok) {
            ctx.log.warn(`wechatpadpro: ${info.kind} reply to ${target} returned not-ok`);
          }
        } catch (err) {
          ctx.log.error(`wechatpadpro: ${info.kind} reply to ${target} failed: ${String(err)}`);
        }
      },
      onError: (err, info) => {
        ctx.log.error(`wechatpadpro: ${info.kind} dispatch error: ${String(err)}`);
      },
    });

  try {
    await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });
  } catch (err) {
    ctx.log.error(`wechatpadpro: dispatchInboundMessage threw: ${String(err)}`);
  } finally {
    markDispatchIdle();
    markRunComplete();
  }
}
