/**
 * frame.ts — map a (core) NormalizedMessage to the downstream wire Frame.
 *
 * Lives in core (not shared) because it depends on NormalizedMessage. The Frame
 * TYPE lives in shared/frame.ts so consumers can depend on the contract alone.
 * Pure: no I/O, no media download. The caller (main) computes any FrameMedia
 * (which needs the WeChat client) and passes it via opts.media; name enrichment
 * (from the contact cache) is likewise the caller's job.
 */
import type { NormalizedMessage } from "./client.js";
import type { Frame, FrameMedia } from "../shared/frame.js";

export interface BuildFrameOpts {
  account: string;
  media?: FrameMedia;
}

/**
 * Best-effort sender display name from WeChat's pushContent, which looks like
 * "Nickname : message text" or "Nickname sent you a ...". Returns "" if no
 * name can be extracted. (Contact-cache resolution is layered on in ingest.)
 */
export function deriveSenderName(pushContent: string): string {
  if (!pushContent) return "";
  const colonIdx = pushContent.indexOf(" : ");
  if (colonIdx > 0) return pushContent.substring(0, colonIdx);
  const sentIdx = pushContent.indexOf(" sent ");
  if (sentIdx > 0) return pushContent.substring(0, sentIdx).trim();
  return "";
}

export function buildFrame(msg: NormalizedMessage, opts: BuildFrameOpts): Frame {
  const from: { wxid: string; name?: string } = {
    wxid: msg.isGroup ? msg.senderWxid : msg.fromUser,
  };
  const name = deriveSenderName(msg.pushContent);
  if (name) from.name = name;

  const frame: Frame = {
    type: "message",
    id: msg.msgId,
    account: opts.account,
    chatType: msg.isGroup ? "group" : "direct",
    from,
    chat: { id: msg.isGroup ? (msg.groupId ?? msg.fromUser) : msg.fromUser },
    text: msg.text,
    mentionedMe: msg.isGroup ? msg.isAtBot : false,
    ts: msg.createTime,
  };

  if (msg.quote) {
    frame.quote = {
      id: msg.quote.referMsgId,
      summary: msg.quote.referSummary,
      senderName: msg.quote.referDisplayName,
      senderWxid: msg.quote.referSenderWxid,
    };
  }
  if (opts.media) frame.media = opts.media;
  return frame;
}
