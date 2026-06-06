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

export function buildFrame(msg: NormalizedMessage, opts: BuildFrameOpts): Frame {
  const frame: Frame = {
    type: "message",
    id: msg.msgId,
    account: opts.account,
    chatType: msg.isGroup ? "group" : "direct",
    from: { wxid: msg.isGroup ? msg.senderWxid : msg.fromUser },
    chat: { id: msg.isGroup ? (msg.groupId ?? msg.fromUser) : msg.fromUser },
    text: msg.text,
    mentionedMe: msg.isGroup ? msg.isAtBot : false,
    ts: msg.createTime,
  };
  if (opts.media) frame.media = opts.media;
  return frame;
}
