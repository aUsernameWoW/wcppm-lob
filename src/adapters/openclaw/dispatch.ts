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
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
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
  /** Send a media URL (image/video/file; kind inferred middleware-side). The
   *  optional caption is sent as a follow-up text for images. */
  sendMedia: (toWxid: string, url: string, caption?: string) => Promise<boolean>;
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
  /**
   * Lazy media fetch (wraps bridge.fetchMedia). Called only after the gate, for
   * messages that carry a media marker, so non-dispatched traffic never triggers
   * a download. Absent in tests / text-only paths → media is skipped silently.
   */
  fetchMedia?: (id: string) => Promise<{ ok: boolean; localPath?: string; mimeType?: string } | null>;
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
  /** Set when the frame carries a lazily-fetchable attachment (image, file, …). */
  mediaKind?: "image" | "voice" | "video" | "file";
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

  // Lazy media fetch — only now that the message has cleared the gate. The
  // middleware downloads the bytes to a shared-filesystem path we hand the
  // agent as MediaPath. A miss/failure degrades gracefully: the text still
  // dispatches without the image.
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (msg.mediaKind && ctx.fetchMedia) {
    try {
      const m = await ctx.fetchMedia(msg.msgId);
      if (m?.ok && m.localPath) {
        mediaPath = m.localPath;
        // Forward the MIME so a non-image attachment (e.g. a .docx) isn't
        // mistaken for an image by the media-understanding pipeline.
        mediaType = m.mimeType;
      } else {
        ctx.log.warn(`wechatpadpro: media fetch for ${msg.msgId} returned no path (${msg.mediaKind})`);
      }
    } catch (err) {
      ctx.log.warn(`wechatpadpro: media fetch for ${msg.msgId} failed: ${String(err)}`);
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
    ...(mediaPath ? { MediaPath: mediaPath } : {}),
    ...(mediaType ? { MediaType: mediaType } : {}),
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
      // Inter-block human delay (resolved from agent defaults / per-agent config).
      // Pauses between streamed reply blocks so a multi-part answer doesn't land
      // all at once. undefined when unconfigured → no delay (current behaviour).
      humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload: ReplyPayload, info) => {
        const text = (payload.text ?? "").trim();
        // The agent may emit a single mediaUrl or a list; normalize to an array.
        const mediaUrls = payload.mediaUrls?.length
          ? payload.mediaUrls
          : payload.mediaUrl
            ? [payload.mediaUrl]
            : [];
        if (!text && mediaUrls.length === 0) return;
        const target = msg.conversationId;
        try {
          if (mediaUrls.length > 0) {
            // Send each attachment; the text rides on the first as its caption,
            // the rest go bare. (Quote-reply is text-only — media isn't quoted.)
            for (let i = 0; i < mediaUrls.length; i++) {
              const caption = i === 0 ? text : "";
              const ok = await ctx.send.sendMedia(target, mediaUrls[i], caption || undefined);
              if (!ok) {
                ctx.log.warn(`wechatpadpro: ${info.kind} media reply to ${target} returned not-ok`);
              }
            }
            return;
          }
          // Quote-reply when the agent flagged a reply target. We use the inbound
          // msgId as the quote target — the agent rarely surfaces a different one
          // and per-channel reply_to mapping is out of scope for v1.
          const quoteId = payload.replyToId || (payload.replyToTag ? msg.msgId : undefined);
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
