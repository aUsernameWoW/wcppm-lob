/**
 * frame.ts — the downstream wire contract (design spec §4.1).
 *
 * A Frame is what the middleware pushes over `WS /subscribe` to subscribers
 * (the OpenClaw adapter, future bots). It is intentionally decoupled from the
 * raw WeChat message shape. This file holds TYPES ONLY (no imports), so both
 * the core (which builds frames) and any consumer can depend on it without
 * pulling in core internals. The mapper lives in `core/frame.ts`.
 */

export interface FrameMedia {
  kind: "image" | "voice" | "video";
  mimeType?: string;
  fileName?: string;
  /** Direct/CDN URL when available. */
  url?: string;
  /** Local file path when the middleware downloaded it (preferred over url). */
  localPath?: string;
}

/** What an inbound message quotes/replies to, when present. */
export interface FrameQuote {
  /** Server-side id of the quoted message. */
  id?: string;
  /** Human-readable summary of the quoted content. */
  summary?: string;
  /** Display name of the quoted message's sender. */
  senderName?: string;
  /** wxid of the quoted message's sender. */
  senderWxid?: string;
}

export interface Frame {
  type: "message";
  /** Globally-unique id (the dedup key). */
  id: string;
  account: string;
  chatType: "group" | "direct";
  /** The sender. For groups this is the in-group member; for DMs, the peer. */
  from: { wxid: string; name?: string };
  /** The conversation. For groups this is the group id; for DMs, the peer wxid. */
  chat: { id: string; name?: string };
  /** Normalized, human-readable text. */
  text: string;
  /** Group @bot mention (always false for DMs). */
  mentionedMe: boolean;
  /** Reply/quote context, when this message quotes another. */
  quote?: FrameQuote;
  media?: FrameMedia;
  /** Server time (seconds). */
  ts: number;
}

/** Sent once when a subscriber connects, before any message frames. */
export interface ReadyFrame {
  type: "ready";
  selfWxid: string;
}
