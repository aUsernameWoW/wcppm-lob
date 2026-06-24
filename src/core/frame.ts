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
import { fileExtToMime, safeFileName } from "./media-meta.js";

export interface BuildFrameOpts {
  account: string;
  media?: FrameMedia;
}

/**
 * Intrinsic media metadata derived purely from the message type (no I/O, no
 * download). For lazy fetch the broadcast frame carries only this metadata —
 * the subscriber pulls the bytes on demand via the bridge `POST /media`
 * endpoint after passing its own gate. Mirrors WcppClient.buildAttachmentCandidate.
 * v1 covers images (MsgType 3); voice/video are stored but not yet fetchable.
 */
function intrinsicMedia(msg: NormalizedMessage): FrameMedia | undefined {
  if (msg.msgType === 3) {
    return { kind: "image", mimeType: "image/jpeg", fileName: `wechat-image-${msg.msgId}.jpg` };
  }
  // File attachment: MsgType 49 with appmsg <type>6</type> (the completed,
  // downloadable file). The <type>74</type> "uploading…" placeholder is
  // suppressed upstream in the client, so it never reaches here.
  if (msg.msgType === 49) {
    const appType = msg.content.match(/<type>\s*(\d+)\s*<\/type>/i)?.[1];
    if (appType === "6") {
      const peek = (tag: string) =>
        msg.content
          .match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"))?.[1]
          ?.trim() ?? null;
      const ext = peek("fileext");
      return {
        kind: "file",
        mimeType: fileExtToMime(ext),
        fileName: safeFileName(peek("title"), msg.msgId, ext),
      };
    }
  }
  return undefined;
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
  // Caller-supplied media (e.g. pre-resolved) wins; otherwise derive metadata
  // from the message type so image frames advertise a lazily-fetchable attachment.
  const media = opts.media ?? intrinsicMedia(msg);
  if (media) frame.media = media;
  return frame;
}
