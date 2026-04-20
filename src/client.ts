/**
 * WeChatPadProMax API client.
 *
 * WebSocket push (`/ws/sync`) is the base inbound transport. Webhook (HTTP
 * push to our local listener) can be enabled as an additional inbound
 * channel alongside WS — duplicates are deduped by MsgId. Outbound always
 * uses the MAX `/api/*` HTTP endpoints.
 *
 * `forceSync()` exposes a one-shot `/api/Msg/Sync` pull for manual
 * catch-up (used by the future force-refresh UI action). There is no
 * persistent polling loop in normal operation.
 */

import WebSocket from "ws";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "openclaw/plugin-sdk/channel-core";

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────

export interface WcppConfig {
  /** WCPPM server host. Required for outbound + WS; may be empty for passive webhook-only receivers. */
  host: string;
  port: number;
  /** WCPPM authcode. Required whenever host is set. */
  authcode?: string;
  /** Cached self wxid (optional; auto-detected from Newinit / WS envelope). */
  wxid?: string;
  proxy?: string;
  replyWithMention?: boolean;
  /** Override WebSocket URL (default: ws://{host}:8089/ws/sync?authcode=…). */
  wsUrl?: string;
  /** Also run a local webhook HTTP listener (additional inbound channel on top of WS). */
  webhookEnabled?: boolean;
  webhookHost?: string;
  webhookPort?: number;
  webhookPath?: string;
  webhookSecret?: string;
  /** External URL to register with WCPPM via /Webhook/Set (ignored in passive mode). */
  webhookUrl?: string;
  /**
   * When true, webhook signature mismatches log the full signing input
   * and include a non-sensitive diagnostic block in the 401 response body.
   * The hex prefix (first 12 chars) of expected/got HMACs is leaked — do
   * NOT enable in production since it narrows brute-force space on the secret.
   */
  webhookDebug?: boolean;
  /**
   * When true, a push whose body.Signature is EMPTY (gotLen=0) is silently
   * 200'd and its messages are dropped rather than dispatched. This is the
   * escape hatch for draining a retry queue that was built during a window
   * when webhookSecret wasn't set on the WCPPM side — those payloads never
   * had a signature to begin with and will 401 forever otherwise.
   *
   * Pushes with a wrong-but-non-empty signature are still rejected with 401.
   */
  webhookSilentDropUnsigned?: boolean;
  readOnly?: boolean;
  allowMsgTypes?: number[];
  passRevokemsg?: boolean;
  maxMessageAge?: number;
}

export interface WcppCredentials {
  authcode: string;
  wxid: string;
}

// ──────────────────────────────────────────────
// Sync response types (PascalCase from MAX API)
// ──────────────────────────────────────────────

export interface SyncResponse {
  Code: number;
  Success: boolean;
  Message: string;
  Data?: {
    AddMsgs: SyncMessage[];
    ModContacts: SyncContact[];
    ModUserInfos: SyncUserInfo[];
    ModUserImgs: unknown[];
    DelContacts: unknown[] | null;
    FunctionSwitchs: unknown[];
    Remarks: unknown[];
    UserInfoExts: unknown[];
    /** Base64-encoded protobuf — this IS the Synckey for next request */
    KeyBuf: { iLen: number; buffer: string };
    /** Continuation cookie — non-zero means more data to fetch */
    Continue: number | null;
    ContinueFlag: number | null;
    Status: number | null;
    /** Server timestamp */
    Time: number | null;
    UnknownCmdId: string | null;
  };
  Data62?: string;
  CodeValue?: string;
  ID?: number;
  Debug?: string;
}

export interface SyncMessage {
  MsgId: number;
  FromUserName: { string: string };
  ToUserName: { string: string };
  MsgType: number;
  Content: { string: string };
  Status?: number;
  ImgStatus?: number;
  ImgBuf?: { iLen: number };
  CreateTime: number;
  MsgSource?: string;
  PushContent?: string;
  NewMsgId: number;
  MsgSeq: number;
}

/**
 * WCPP MAX 20260411+ WebSocket envelope.
 * The server wraps SyncResponse in an outer envelope with two known shapes:
 *   - { Data: { syncData: SyncResponse, wxid, time } }
 *   - { Data: { data: SyncResponse, type: "sync_message", timestamp } }
 */
interface MaxWsEnvelope {
  Code: number;
  Success: boolean;
  Message?: string;
  Data?: {
    syncData?: SyncResponse;
    data?: SyncResponse;
    wxid?: string;
    time?: string;
    type?: string;
    timestamp?: number;
  };
  Data62?: string;
  Debug?: string;
}

/**
 * Webhook push envelope from WCPP MAX.
 * POST'd to our local HTTP server when webhook mode is active.
 */
interface WebhookEnvelope {
  MessageType: string;
  Signature: string;
  Timestamp: number;
  Wxid: string;
  IsSelf: boolean;
  Data: {
    messages: WebhookMessage[];
  };
}

interface WebhookMessage {
  createTime: number;
  fromUser: string;
  fromNick?: string;
  toUser: string;
  isSelf: boolean;
  msgId: number;
  newMsgId: number;
  msgType: number;
  text?: string;
  pushContent?: string;
  rawContent?: string;
  voice?: Record<string, unknown>;
  image?: Record<string, unknown>;
}

export interface SyncContact {
  UserName: { string: string };
  NickName: { string: string };
  Alias?: { string: string } | {};
  PyInitial?: { string: string };
  QuanPin?: { string: string };
  Remark?: { string: string } | {};
  RemarkPyinitial?: { string: string } | {};
  RemarkQuanPin?: { string: string } | {};
  Sex?: number;
  BigHeadImgUrl?: string;
  SmallHeadImgUrl?: string;
  Signature?: string;
  VerifyFlag?: number;
  ChatroomMaxCount?: number;
  ChatroomStatus?: number;
  DeleteFlag?: number;
  MemberCount?: number;
  [key: string]: unknown;
}

export interface SyncUserInfo {
  UserName: { string: string };
  NickName: { string: string };
  BindMobile?: { string: string };
  [key: string]: unknown;
}

// ──────────────────────────────────────────────
// Normalized message type (unified for WS & Sync)
// ──────────────────────────────────────────────

/** Metadata extracted from a quote/reply message's `<refermsg>` XML. */
export interface QuoteInfo {
  /** Server-side message ID of the quoted message (`<svrid>`) */
  referMsgId: string;
  /** wxid of the original message sender (`<chatusr>`) */
  referSenderWxid: string;
  /** Display name of the original sender (`<displayname>`) */
  referDisplayName: string;
  /** Content of the quoted message (`<content>`) — raw text or XML depending on type */
  referContent: string;
  /** MsgType of the quoted message (`<type>`) */
  referType: number;
  /** Human-readable summary of the quoted content */
  referSummary: string;
}

export interface NormalizedMessage {
  msgId: string;
  fromUser: string;
  toUser: string;
  msgType: number;
  content: string;
  pushContent: string;
  msgSource: string;
  createTime: number;
  /** For group messages: the sender wxid extracted from content */
  senderWxid: string;
  /** Actual text (after stripping sender wxid prefix in group msgs) */
  text: string;
  /** Is this a group message? */
  isGroup: boolean;
  /** Group ID if group message */
  groupId: string | null;
  /** Is the bot @mentioned? */
  isAtBot: boolean;
  /** Quote/reply metadata if this message quotes another */
  quote: QuoteInfo | null;
  /** Raw underlying message (WS or Sync format) */
  raw: unknown;
}

export interface VoiceMessageInfo {
  msgId: number | null;
  fromUserName: string | null;
  bufid: string | null;
  length: number | null;
  voiceUrl: string | null;
  aesKey: string | null;
  fileName: string | null;
  rawXml: string;
}

export interface VoiceDownloadResult {
  contentType: string | null;
  buffer: Buffer | null;
  outputPath?: string;
  responseJson?: unknown;
}

export interface ImageMessageInfo {
  msgId: number | null;
  fromUserName: string | null;
  aesKey: string | null;
  cdnMidImgUrl: string | null;
  cdnBigImgUrl: string | null;
  cdnThumbUrl: string | null;
  md5: string | null;
  fileLength: number | null;
  rawXml: string;
}

export interface VideoMessageInfo {
  msgId: number | null;
  fromUserName: string | null;
  aesKey: string | null;
  cdnVideoUrl: string | null;
  cdnThumbUrl: string | null;
  md5: string | null;
  newMd5: string | null;
  fileLength: number | null;
  playLengthSeconds: number | null;
  rawXml: string;
}

export interface MediaDownloadResult {
  contentType: string | null;
  buffer: Buffer | null;
  outputPath?: string;
  responseJson?: unknown;
  requestPayload: Record<string, unknown>;
}

export interface AttachmentCandidate {
  kind: "voice" | "image" | "video";
  mimeType: string;
  fileName: string;
  extension: string;
  msgId: string;
}

export type ResolvedMedia =
  | {
      kind: "voice";
      info: VoiceMessageInfo;
      attachment: AttachmentCandidate;
      download: (outputPath?: string) => Promise<VoiceDownloadResult>;
      materialize: (dir?: string) => Promise<{ filePath: string; mimeType: string; fileName: string }>;
    }
  | {
      kind: "image";
      info: ImageMessageInfo;
      attachment: AttachmentCandidate;
      download: (outputPath?: string) => Promise<MediaDownloadResult>;
      materialize: (dir?: string) => Promise<{ filePath: string; mimeType: string; fileName: string }>;
    }
  | {
      kind: "video";
      info: VideoMessageInfo;
      attachment: AttachmentCandidate;
      download: (outputPath?: string) => Promise<MediaDownloadResult>;
      materialize: (dir?: string) => Promise<{ filePath: string; mimeType: string; fileName: string }>;
    };

// ──────────────────────────────────────────────
// Client
// ──────────────────────────────────────────────

type MessageHandler = (msg: NormalizedMessage) => void;

export class WcppClient {
  public wxid: string | null;
  private baseUrl: string;

  // Sync cursor (used by forceSync and by the login verify call)
  private synckey: string; // base64 KeyBuf.buffer for next request
  private continueFlag: number;
  private seenMsgIds: Set<string> = new Set();
  private readonly SEEN_MSG_ID_MAX = 10000;

  // Webhook state
  private webhookServer: HttpServer | null = null;

  // Contact cache (from Sync responses)
  private contactCache: Map<string, SyncContact> = new Map();

  // Common
  private _onMessage: MessageHandler | null = null;
  private config: WcppConfig;

  constructor(
    config: WcppConfig,
    private log: Logger,
  ) {
    this.config = config;
    this.wxid = config.wxid ?? null;
    this.baseUrl = config.host ? `http://${config.host}:${config.port}` : "";
    this.synckey = "string"; // initial value for first Sync call
    this.continueFlag = 0;
  }

  private requireAuthcode(): string {
    const ac = this.config.authcode;
    if (!ac) throw new Error("WCPPM: authcode is required");
    return ac;
  }

  private authQuery(): string {
    return `authcode=${this.requireAuthcode()}`;
  }

  // ──────────────────────────────────────────────
  // Public properties
  // ──────────────────────────────────────────────

  get onMessage() { return this._onMessage; }
  set onMessage(handler: MessageHandler | null) { this._onMessage = handler; }

  /** Get cached contact by wxid */
  getContact(wxid: string): SyncContact | undefined {
    return this.contactCache.get(wxid);
  }

  // ──────────────────────────────────────────────
  // Auth & Login
  // ──────────────────────────────────────────────

  /**
   * Verify the configured authcode is usable.
   *
   * Passive webhook-only mode (no host): we cannot and must not contact the
   * server — /Login/Newinit and /Webhook/Set are the operator's job. Return
   * a synthetic credentials object so the gateway treats the channel as up.
   *
   * Active mode (host set): skip /Login/Newinit (that stays the operator's
   * responsibility — see CLAUDE.md "Scope & Responsibilities") and verify
   * the authcode via a single /api/Msg/Sync probe.
   */
  async login(): Promise<WcppCredentials | null> {
    if (!this.config.host) {
      this.log.info("WCPPM: passive webhook-only mode (no host); skipping server verification");
      return { authcode: this.config.authcode ?? "", wxid: this.wxid ?? "unknown" };
    }

    if (!this.config.authcode) {
      this.log.error("WCPPM: authcode is required when host is set");
      return null;
    }

    const testResult = await this.doSyncRequest();
    if (!testResult || !testResult.Success) {
      this.log.error("WCPPM: sync probe failed, authcode may be invalid");
      return null;
    }

    if (testResult.Data?.ModUserInfos?.[0]) {
      this.wxid = testResult.Data.ModUserInfos[0].UserName.string;
      this.log.info(`WCPPM: sync probe OK, wxid=${this.wxid}`);
      this.ingestContacts(testResult);
      if (testResult.Data.KeyBuf?.buffer) {
        this.synckey = testResult.Data.KeyBuf.buffer;
      }
      return { authcode: this.config.authcode, wxid: this.wxid! };
    }

    this.log.info("WCPPM: sync probe OK but no ModUserInfos");
    return { authcode: this.config.authcode, wxid: this.wxid ?? "unknown" };
  }

  // ──────────────────────────────────────────────
  // Newinit (WCPP MAX 0412+ longlink establishment)
  // ──────────────────────────────────────────────

  /**
   * Call /Login/Newinit to initialize the longlink connection.
   * Required on WCPP MAX 0412+ to enable the unified dispatch pipeline.
   * Returns the initial Synckey pair, or null on failure.
   */
  async newinit(maxSynckey?: string, currentSynckey?: string): Promise<{
    currentSynckey: string;
    maxSynckey: string;
    wxid: string | null;
  } | null> {
    const authcode = this.config.authcode;
    if (!authcode) {
      this.log.error("WCPP MAX: cannot call Newinit without authcode");
      return null;
    }

    let url = `${this.baseUrl}/api/Login/Newinit?authcode=${authcode}`;
    if (maxSynckey) url += `&MaxSynckey=${encodeURIComponent(maxSynckey)}`;
    if (currentSynckey) url += `&CurrentSynckey=${encodeURIComponent(currentSynckey)}`;

    try {
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) {
        this.log.error(`WCPP MAX: Newinit HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as any;
      if (!data.Success) {
        this.log.error(`WCPP MAX: Newinit failed: ${data.Message}`);
        return null;
      }

      const d = data.Data;
      const curKey = d?.CurrentSynckey?.buffer ?? "";
      const maxKey = d?.MaxSynckey?.buffer ?? "";

      // Extract wxid from ModUserInfos
      let wxid: string | null = null;
      if (d?.ModUserInfos?.[0]?.UserName?.string) {
        wxid = d.ModUserInfos[0].UserName.string;
      }

      this.log.info(`WCPP MAX: Newinit OK${wxid ? ` (wxid=${wxid})` : ""}, longlink established`);
      return { currentSynckey: curKey, maxSynckey: maxKey, wxid };
    } catch (e) {
      this.log.error("WCPP MAX: Newinit request error", e);
      return null;
    }
  }

  // ──────────────────────────────────────────────
  // Sync polling (WCPP MAX)
  // ──────────────────────────────────────────────

  private async doSyncRequest(): Promise<SyncResponse | null> {
    const authcode = this.config.authcode;
    if (!authcode) return null;

    const url = `${this.baseUrl}/api/Msg/Sync?authcode=${authcode}`;
    const payload = { Scene: 0, Synckey: this.synckey };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        this.log.error(`WCPP MAX: Sync HTTP ${res.status}`);
        return null;
      }
      return (await res.json()) as SyncResponse;
    } catch (e) {
      this.log.error("WCPP MAX: Sync request error", e);
      return null;
    }
  }

  /**
   * Process a Sync response: update synckey, cache contacts, emit messages.
   */
  private processSyncResponse(resp: SyncResponse): void {
    if (!resp.Data) return;

    // Update synckey for next poll
    if (resp.Data.KeyBuf?.buffer) {
      this.synckey = resp.Data.KeyBuf.buffer;
    }

    // Update continue flag
    this.continueFlag = resp.Data.ContinueFlag ?? 0;

    // Cache contacts
    this.ingestContacts(resp);

    // Extract self wxid from ModUserInfos if not set
    if (!this.wxid && resp.Data.ModUserInfos?.[0]) {
      this.wxid = resp.Data.ModUserInfos[0].UserName.string;
      this.log.info(`WCPP MAX: detected wxid=${this.wxid} from sync`);
    }

    // Process messages
    const allowTypes = this.config.allowMsgTypes ?? [1, 3, 34, 47, 48, 49];
    const passRevoke = this.config.passRevokemsg ?? true;
    const maxAge = this.config.maxMessageAge ?? 180;

    for (const msg of resp.Data.AddMsgs ?? []) {
      // Use MsgId as dedup key — NewMsgId can lose precision via JSON.parse
      const dedupKey = `${msg.MsgId}`;

      // Dedup
      if (this.seenMsgIds.has(dedupKey)) continue;

      // Filter by MsgType
      if (msg.MsgType === 51) continue; // Always drop status sync
      if (msg.MsgType === 10002) {
        // Only pass through revokemsg if configured
        if (!passRevoke) continue;
        const content = msg.Content.string;
        if (!content.includes("revokemsg")) continue;
      } else if (!allowTypes.includes(msg.MsgType)) {
        continue;
      }

      // Age filter
      if (Date.now() / 1000 - msg.CreateTime > maxAge) continue;

      // Mark seen
      this.seenMsgIds.add(dedupKey);
      if (this.seenMsgIds.size > this.SEEN_MSG_ID_MAX) {
        // Evict oldest entries (simple approach: clear half)
        const entries = [...this.seenMsgIds];
        this.seenMsgIds = new Set(entries.slice(entries.length / 2));
      }

      // Normalize and emit
      const normalized = this.normalizeSyncMessage(msg);
      if (normalized) {
        // Drop own messages (unless from filehelper or similar)
        if (normalized.senderWxid === this.wxid && !normalized.isGroup) continue;
        this._onMessage?.(normalized);
      }
    }
  }

  private ingestContacts(resp: SyncResponse): void {
    if (!resp.Data?.ModContacts) return;
    for (const c of resp.Data.ModContacts) {
      const wxid = c.UserName?.string;
      if (wxid) this.contactCache.set(wxid, c);
    }
  }

  private extractXmlTag(content: string, tag: string): string | null {
    const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return match?.[1]?.trim() || null;
  }

  /**
   * Parse a quote/reply message (MsgType 49, appType 57) and extract
   * the `<refermsg>` metadata.  Returns null if not a quote message.
   */
  parseQuoteMessage(xml: string): QuoteInfo | null {
    const appType = this.extractXmlTag(xml, "type");
    if (appType !== "57") return null;

    const referBlock = xml.match(/<refermsg>([\s\S]*?)<\/refermsg>/i)?.[1];
    if (!referBlock) return null;

    const referMsgId = this.extractXmlTag(referBlock, "svrid") ?? "";
    const referSenderWxid = this.extractXmlTag(referBlock, "chatusr") ?? "";
    const referDisplayName = this.extractXmlTag(referBlock, "displayname") ?? "";
    const referTypeStr = this.extractXmlTag(referBlock, "type") ?? "1";
    const referType = Number(referTypeStr) || 1;

    // <content> in refermsg is HTML-entity-escaped for non-text types (images,
    // locations, cards etc.) and may have a leading \n — unescape and trim.
    let referContent = this.extractXmlTag(referBlock, "content") ?? "";
    referContent = this.unescapeXmlEntities(referContent).replace(/^\n+/, "");

    const referSummary = this.summarizeQuotedContent(referType, referContent);

    return {
      referMsgId,
      referSenderWxid,
      referDisplayName,
      referContent,
      referType,
      referSummary,
    };
  }

  /**
   * Produce a short human-readable summary of quoted message content,
   * reusing the same logic as formatInboundDisplayText where applicable.
   */
  private summarizeQuotedContent(msgType: number, content: string): string {
    if (msgType === 1) return content.length > 80 ? content.slice(0, 80) + "…" : content;
    if (msgType === 3) return "[图片]";
    if (msgType === 34) return "[语音]";
    if (msgType === 47) return "[表情]";
    if (msgType === 48) {
      const poiname = this.extractXmlAttr(content, "location", "poiname");
      return poiname ? `[位置] ${poiname}` : "[位置]";
    }
    if (msgType === 49) {
      const title = this.extractXmlTag(content, "title");
      if (title) return `[卡片] ${title}`;
      return "[卡片消息]";
    }
    // Fallback: truncate raw content
    return content.length > 60 ? content.slice(0, 60) + "…" : content || "[消息]";
  }

  private unescapeXmlEntities(s: string): string {
    return s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
  }

  private extractXmlAttr(content: string, tag: string, attr: string): string | null {
    const tagMatch = content.match(new RegExp(`<${tag}\\s[^>]*${attr}="([^"]*)"`, "i"));
    return tagMatch?.[1] || null;
  }

  private formatVoiceDuration(raw: string): string | null {
    const value =
      raw.match(/<voicelength>(\d+)<\/voicelength>/i)?.[1] ||
      raw.match(/voicelength="(\d+)"/i)?.[1] ||
      raw.match(/length="(\d+)"/i)?.[1];
    if (!value) return null;
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    const seconds = num > 300 ? Math.round(num / 1000) : num;
    return `${seconds}s`;
  }

  extractVoiceMessageInfo(message: SyncMessage | NormalizedMessage): VoiceMessageInfo | null {
    const rawXml = "content" in message ? message.content : message.Content?.string ?? "";
    const fromUserName = "fromUser" in message
      ? message.fromUser
      : message.FromUserName?.string ?? null;
    const msgId = "msgId" in message
      ? Number(message.msgId)
      : message.MsgId ?? null;

    if (!("msgType" in message ? message.msgType === 34 : message.MsgType === 34)) {
      return null;
    }

    const bufid =
      rawXml.match(/<bufid>([^<]+)<\/bufid>/i)?.[1] ||
      rawXml.match(/bufid="([^"]+)"/i)?.[1] ||
      null;
    const lengthRaw =
      rawXml.match(/<voicelength>(\d+)<\/voicelength>/i)?.[1] ||
      rawXml.match(/voicelength="(\d+)"/i)?.[1] ||
      rawXml.match(/length="(\d+)"/i)?.[1] ||
      null;
    const voiceUrl =
      rawXml.match(/<voiceurl><!\[CDATA\[(.*?)\]\]><\/voiceurl>/i)?.[1] ||
      rawXml.match(/<voiceurl>([^<]+)<\/voiceurl>/i)?.[1] ||
      null;
    const aesKey =
      rawXml.match(/<aeskey><!\[CDATA\[(.*?)\]\]><\/aeskey>/i)?.[1] ||
      rawXml.match(/<aeskey>([^<]+)<\/aeskey>/i)?.[1] ||
      null;
    const fileName =
      rawXml.match(/<filename><!\[CDATA\[(.*?)\]\]><\/filename>/i)?.[1] ||
      rawXml.match(/<filename>([^<]+)<\/filename>/i)?.[1] ||
      null;

    return {
      msgId: Number.isFinite(msgId) ? msgId : null,
      fromUserName,
      bufid,
      length: lengthRaw ? Number(lengthRaw) : null,
      voiceUrl,
      aesKey,
      fileName,
      rawXml,
    };
  }

  extractImageMessageInfo(message: SyncMessage | NormalizedMessage): ImageMessageInfo | null {
    const rawXml = "content" in message ? message.content : message.Content?.string ?? "";
    const fromUserName = "fromUser" in message
      ? message.fromUser
      : message.FromUserName?.string ?? null;
    const msgId = "msgId" in message
      ? Number(message.msgId)
      : message.MsgId ?? null;

    if (!("msgType" in message ? message.msgType === 3 : message.MsgType === 3)) {
      return null;
    }

    const pick = (...patterns: RegExp[]) => {
      for (const pattern of patterns) {
        const m = rawXml.match(pattern)?.[1];
        if (m) return m;
      }
      return null;
    };

    const fileLengthRaw = pick(/<length>(\d+)<\/length>/i, /length="(\d+)"/i, /hdlength="(\d+)"/i);

    return {
      msgId: Number.isFinite(msgId) ? msgId : null,
      fromUserName,
      aesKey: pick(/<aeskey><!\[CDATA\[(.*?)\]\]><\/aeskey>/i, /<aeskey>([^<]+)<\/aeskey>/i),
      cdnMidImgUrl: pick(/<cdnmidimgurl><!\[CDATA\[(.*?)\]\]><\/cdnmidimgurl>/i, /<cdnmidimgurl>([^<]+)<\/cdnmidimgurl>/i),
      cdnBigImgUrl: pick(/<cdnbigimgurl><!\[CDATA\[(.*?)\]\]><\/cdnbigimgurl>/i, /<cdnbigimgurl>([^<]+)<\/cdnbigimgurl>/i),
      cdnThumbUrl: pick(/<cdnthumburl><!\[CDATA\[(.*?)\]\]><\/cdnthumburl>/i, /<cdnthumburl>([^<]+)<\/cdnthumburl>/i),
      md5: pick(/<md5>([^<]+)<\/md5>/i, /md5="([^"]+)"/i),
      fileLength: fileLengthRaw ? Number(fileLengthRaw) : null,
      rawXml,
    };
  }

  extractVideoMessageInfo(message: SyncMessage | NormalizedMessage): VideoMessageInfo | null {
    const rawXml = "content" in message ? message.content : message.Content?.string ?? "";
    const fromUserName = "fromUser" in message
      ? message.fromUser
      : message.FromUserName?.string ?? null;
    const msgId = "msgId" in message
      ? Number(message.msgId)
      : message.MsgId ?? null;

    const msgType = "msgType" in message ? message.msgType : message.MsgType;
    if (msgType !== 43 && msgType !== 62) {
      return null;
    }

    const pick = (...patterns: RegExp[]) => {
      for (const pattern of patterns) {
        const m = rawXml.match(pattern)?.[1];
        if (m) return m;
      }
      return null;
    };

    const fileLengthRaw = pick(/<length>(\d+)<\/length>/i, /length="(\d+)"/i);
    const playLengthRaw = pick(/<playlength>(\d+)<\/playlength>/i, /playlength="(\d+)"/i);

    return {
      msgId: Number.isFinite(msgId) ? msgId : null,
      fromUserName,
      aesKey: pick(/<aeskey><!\[CDATA\[(.*?)\]\]><\/aeskey>/i, /<aeskey>([^<]+)<\/aeskey>/i),
      cdnVideoUrl: pick(/<cdnvideourl><!\[CDATA\[(.*?)\]\]><\/cdnvideourl>/i, /<cdnvideourl>([^<]+)<\/cdnvideourl>/i),
      cdnThumbUrl: pick(/<cdnthumburl><!\[CDATA\[(.*?)\]\]><\/cdnthumburl>/i, /<cdnthumburl>([^<]+)<\/cdnthumburl>/i),
      md5: pick(/<md5>([^<]+)<\/md5>/i, /md5="([^"]+)"/i),
      newMd5: pick(/<newmd5>([^<]+)<\/newmd5>/i, /newmd5="([^"]+)"/i),
      fileLength: fileLengthRaw ? Number(fileLengthRaw) : null,
      playLengthSeconds: playLengthRaw ? Number(playLengthRaw) : null,
      rawXml,
    };
  }

  private formatInboundDisplayText(msgType: number, content: string): string {
    if (msgType === 3) return "[图片]";

    if (msgType === 34) {
      const duration = this.formatVoiceDuration(content);
      return duration ? `[语音] ${duration}` : "[语音]";
    }

    if (msgType === 47) {
      const name = this.extractXmlTag(content, "emoji") || this.extractXmlTag(content, "des");
      return name ? `[表情] ${name}` : "[表情]";
    }

    if (msgType === 48) {
      const poiname = this.extractXmlAttr(content, "location", "poiname");
      const label = this.extractXmlAttr(content, "location", "label");
      const display = poiname || label;
      return display ? `[位置] ${display}` : "[位置]";
    }

    if (msgType === 49) {
      const title = this.extractXmlTag(content, "title");
      const appType = this.extractXmlTag(content, "type");
      const url = this.extractXmlTag(content, "url");
      // Quote/reply: <title> is the user's actual reply text — return it as-is.
      // The quoted context is attached separately via NormalizedMessage.quote.
      if (appType === "57") return title ?? "";
      if (appType === "5") return title ? `[链接] ${title}` : (url ? `[链接] ${url}` : "[链接]");
      if (title) return `[卡片] ${title}`;
      return "[卡片消息]";
    }

    if (msgType === 10002) {
      const revokeMatch = content.match(/replacemsg><!\[CDATA\[(.*?)\]\]>/);
      if (revokeMatch) return `[撤回] ${revokeMatch[1]}`;
      return "[系统消息]";
    }

    return content;
  }

  /**
   * Normalize a Sync message into our unified format.
   */
  private normalizeSyncMessage(msg: SyncMessage): NormalizedMessage | null {
    const fromUser = msg.FromUserName?.string ?? "";
    const content = msg.Content?.string ?? "";
    const pushContent = msg.PushContent ?? "";
    const msgSource = msg.MsgSource ?? "";

    const isGroup = fromUser.includes("@chatroom");
    let senderWxid = fromUser;
    let text = content;
    let groupId: string | null = null;
    let isAtBot = false;

    if (isGroup) {
      groupId = fromUser;
      // Group format: "sender_wxid:\nactual message"
      const colonIdx = content.indexOf(":\n");
      if (colonIdx > 0) {
        senderWxid = content.substring(0, colonIdx);
        text = content.substring(colonIdx + 2);
      }
      // Check @bot
      if (this.wxid) {
        isAtBot =
          msgSource.includes(`<atuserlist>${this.wxid}</atuserlist>`) ||
          msgSource.includes(`<atuserlist>${this.wxid},`) ||
          msgSource.includes(`,${this.wxid}</atuserlist>`) ||
          pushContent.includes("在群聊中@了你");
      }
    } else {
      // Private message — extract nickname from pushContent
      // "Nickname : content" or just content
      if (pushContent.includes(" : ")) {
        text = content; // DM content IS the text
      }
    }

    // Parse quote/reply metadata for MsgType 49
    const quote = msg.MsgType === 49 ? this.parseQuoteMessage(text) : null;

    text = this.formatInboundDisplayText(msg.MsgType, text);

    // Prefer NewMsgId for global uniqueness, but fall back to MsgId if
    // NewMsgId looks like it suffered JS precision loss (ends in 000+).
    const rawNewId = String(msg.NewMsgId);
    const stableId =
      rawNewId.length > 15 && rawNewId.endsWith("000")
        ? String(msg.MsgId)
        : rawNewId;

    return {
      msgId: stableId,
      fromUser,
      toUser: msg.ToUserName?.string ?? "",
      msgType: msg.MsgType,
      content,
      pushContent,
      msgSource,
      createTime: msg.CreateTime,
      senderWxid,
      text,
      isGroup,
      groupId,
      isAtBot,
      quote,
      raw: msg,
    };
  }

  /**
   * Run a one-shot /api/Msg/Sync pull and feed the result through the
   * standard dedup + filter + normalize pipeline. Follows `ContinueFlag`
   * so a single call drains all backlog.
   *
   * Intended for manual catch-up (e.g. a future force-refresh UI action).
   * Normal inbound flow runs over WebSocket and optionally webhook.
   */
  async forceSync(): Promise<boolean> {
    for (;;) {
      const resp = await this.doSyncRequest();
      if (!resp) return false;
      if (!resp.Success) {
        this.log.warn(`WCPPM: forceSync Sync returned !Success: Code=${resp.Code} Message=${resp.Message}`);
        return false;
      }
      if (resp.Data) this.processSyncResponse(resp);
      if (this.continueFlag === 0) return true;
      this.log.debug("WCPPM: forceSync ContinueFlag != 0, pulling again");
    }
  }

  // ──────────────────────────────────────────────
  // WebSocket (WCPPM push — base inbound transport)
  // ──────────────────────────────────────────────

  private maxWs: WebSocket | null = null;
  private maxWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connectMaxWebSocket(): void {
    const authcode = this.config.authcode;
    if (!authcode) {
      this.log.error("WCPP MAX: cannot connect WS without authcode");
      return;
    }

    // Use custom wsUrl if provided, otherwise construct from host
    const wsUrl = this.config.wsUrl ?? `ws://${this.config.host}:8089/ws/sync?authcode=${authcode}`;
    this.log.info(`WCPP MAX: connecting WebSocket to ${wsUrl.replace(/authcode=[^&]+/, "authcode=***")}`);

    this.maxWs = new WebSocket(wsUrl);

    this.maxWs.on("open", () => {
      this.log.info("WCPP MAX: WebSocket connected");
    });

    this.maxWs.on("message", (raw: WebSocket.Data) => {
      try {
        const envelope = JSON.parse(raw.toString()) as MaxWsEnvelope;
        if (!envelope.Success || !envelope.Data) return;

        // Unwrap: 20260411+ wraps SyncResponse inside Data.syncData or Data.data
        const inner: SyncResponse | undefined =
          envelope.Data.syncData ?? envelope.Data.data ?? undefined;

        if (!inner?.Success || !inner?.Data) {
          this.log.debug("WCPP MAX: WS envelope has no recognizable inner SyncResponse");
          return;
        }

        // Extract wxid from envelope-level field (available in syncData variant)
        if (!this.wxid && envelope.Data.wxid) {
          this.wxid = envelope.Data.wxid;
          this.log.info(`WCPP MAX: detected wxid=${this.wxid} from WS envelope`);
        }

        // Process the unwrapped SyncResponse
        this.ingestContacts(inner);
        if (!this.wxid && inner.Data.ModUserInfos?.[0]) {
          this.wxid = inner.Data.ModUserInfos[0].UserName.string;
          this.log.info(`WCPP MAX: detected wxid=${this.wxid} from WS ModUserInfos`);
        }

        const allowTypes = this.config.allowMsgTypes ?? [1, 3, 34, 47, 48, 49];
        const passRevoke = this.config.passRevokemsg ?? true;
        const maxAge = this.config.maxMessageAge ?? 180;

        for (const msg of inner.Data.AddMsgs ?? []) {
          // Use MsgId as primary dedup key — NewMsgId suffers from JS number
          // precision loss for values > Number.MAX_SAFE_INTEGER, and the server
          // may push the same message in multiple envelope formats.
          const dedupKey = `${msg.MsgId}`;
          if (this.seenMsgIds.has(dedupKey)) continue;
          if (msg.MsgType === 51) continue;
          if (msg.MsgType === 10002) {
            if (!passRevoke) continue;
            if (!msg.Content.string.includes("revokemsg")) continue;
          } else if (!allowTypes.includes(msg.MsgType)) {
            continue;
          }
          if (Date.now() / 1000 - msg.CreateTime > maxAge) continue;

          this.seenMsgIds.add(dedupKey);
          if (this.seenMsgIds.size > this.SEEN_MSG_ID_MAX) {
            const entries = [...this.seenMsgIds];
            this.seenMsgIds = new Set(entries.slice(entries.length / 2));
          }

          const normalized = this.normalizeSyncMessage(msg);
          if (normalized && normalized.senderWxid !== this.wxid) {
            this._onMessage?.(normalized);
          }
        }
      } catch (e) {
        this.log.debug("WCPP MAX: WS message parse error", e);
      }
    });

    this.maxWs.on("close", (code) => {
      this.log.warn(`WCPP MAX: WebSocket closed (code=${code}), reconnecting in 5s...`);
      this.scheduleMaxWsReconnect();
    });

    this.maxWs.on("error", (err) => this.log.error("WCPP MAX: WebSocket error", err));

    // Keepalive
    const pingInterval = setInterval(() => {
      if (this.maxWs?.readyState === WebSocket.OPEN) {
        this.maxWs.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30_000);
  }

  private scheduleMaxWsReconnect(): void {
    if (this.maxWsReconnectTimer) return;
    this.maxWsReconnectTimer = setTimeout(() => {
      this.maxWsReconnectTimer = null;
      this.connectMaxWebSocket();
    }, 5000);
  }

  disconnectMaxWebSocket(): void {
    if (this.maxWsReconnectTimer) {
      clearTimeout(this.maxWsReconnectTimer);
      this.maxWsReconnectTimer = null;
    }
    if (this.maxWs) {
      this.maxWs.removeAllListeners();
      this.maxWs.close();
      this.maxWs = null;
    }
  }

  // ──────────────────────────────────────────────
  // Webhook receive mode (WCPP MAX pushes to us)
  // ──────────────────────────────────────────────

  startWebhookServer(): void {
    const host = this.config.webhookHost ?? "127.0.0.1";
    const port = this.config.webhookPort ?? 8000;
    const basePath = this.config.webhookPath ?? "/webhook";

    this.webhookServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      // Only accept POST on webhook path
      if (req.method !== "POST" || !req.url?.startsWith(basePath)) {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const envelope = JSON.parse(body) as WebhookEnvelope;

          // Signature verification
          if (this.config.webhookSecret) {
            const verdict = this.verifyWebhookSignature(envelope, this.config.webhookSecret);
            if (!verdict.ok) {
              // Silent-drop escape hatch: empty signature field means the
              // push was enqueued before a secret was configured on WCPPM.
              // Accept + drop so WCPPM removes it from the retry queue, but
              // do NOT run it through the agent pipeline.
              if (verdict.gotLen === 0 && this.config.webhookSilentDropUnsigned === true) {
                const n = envelope.Data?.messages?.length ?? 0;
                this.log.warn(
                  `WCPP MAX: silently dropping unsigned push ` +
                  `(ts=${envelope.Timestamp}, age=${Math.round(Date.now() / 1000 - envelope.Timestamp)}s, msgCount=${n})`
                );
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, dropped: true, reason: "unsigned" }));
                return;
              }
              const debug = this.config.webhookDebug === true;
              if (debug) {
                // Include envelope top-level keys and request headers so we
                // can spot a stale sender that puts Signature in a header
                // or under a different case (e.g. "signature").
                const envKeys = Object.keys(envelope as unknown as Record<string, unknown>).join(",");
                const headerKeys = Object.keys(req.headers).join(",");
                const sigHeader = req.headers["x-signature"] ?? req.headers["signature"] ?? "(none)";
                this.log.warn(
                  `WCPP MAX: webhook signature verification failed — ` +
                  `signingInput="${verdict.signingInput}" ` +
                  `expectedPrefix=${verdict.expectedPrefix} ` +
                  `gotPrefix=${verdict.gotPrefix} ` +
                  `gotLen=${verdict.gotLen} ` +
                  `isSelf=${envelope.IsSelf} ` +
                  `msgCount=${envelope.Data?.messages?.length ?? 0} ` +
                  `secretLen=${this.config.webhookSecret.length} ` +
                  `envKeys=[${envKeys}] ` +
                  `headerKeys=[${headerKeys}] ` +
                  `x-signature=${sigHeader}`
                );
              } else {
                this.log.warn("WCPP MAX: webhook signature verification failed (enable webhookDebug for details)");
              }
              // WCPPM's delivery log extracts `.message` for 4xx responses
              // (vs raw body for 5xx), so pack diagnostics into `message`
              // when debug is on — otherwise their log field stays empty.
              const debugMsg = `invalid signature: input="${verdict.signingInput}" expected=${verdict.expectedPrefix}.. got=${verdict.gotPrefix}.. gotLen=${verdict.gotLen} secretLen=${this.config.webhookSecret.length}`;
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify(debug
                ? {
                    ok: false,
                    message: debugMsg,
                    error: "invalid signature",
                    debug: {
                      signingInput: verdict.signingInput,
                      expectedPrefix: verdict.expectedPrefix,
                      gotPrefix: verdict.gotPrefix,
                      gotLen: verdict.gotLen,
                      isSelf: envelope.IsSelf,
                      msgCount: envelope.Data?.messages?.length ?? 0,
                      secretLen: this.config.webhookSecret.length,
                    },
                  }
                : { ok: false, message: "invalid signature", error: "invalid signature" }
              ));
              return;
            }
          }

          // Timestamp anti-replay check (15 minute window)
          if (Math.abs(Date.now() / 1000 - envelope.Timestamp) > 900) {
            this.log.warn("WCPP MAX: webhook timestamp skew too large");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, warning: "timestamp skew" }));
            return;
          }

          // Learn wxid from envelope
          if (!this.wxid && envelope.Wxid) {
            this.wxid = envelope.Wxid;
            this.log.info(`WCPP MAX: detected wxid=${this.wxid} from webhook`);
          }

          // Process messages through the standard pipeline
          this.processWebhookMessages(envelope);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          this.log.debug("WCPP MAX: webhook parse error", e);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
        }
      });
    });

    this.webhookServer.listen(port, host, () => {
      this.log.info(`WCPP MAX: webhook server listening on ${host}:${port}${basePath}`);
    });
  }

  stopWebhookServer(): void {
    if (this.webhookServer) {
      this.webhookServer.close();
      this.webhookServer = null;
      this.log.info("WCPP MAX: webhook server stopped");
    }
  }

  private verifyWebhookSignature(
    envelope: WebhookEnvelope,
    secret: string,
  ): { ok: true } | { ok: false; signingInput: string; expectedPrefix: string; gotPrefix: string; gotLen: number } {
    const signingInput = `${envelope.Wxid}:${envelope.MessageType}:${envelope.Timestamp}`;
    const expected = createHmac("sha256", secret).update(signingInput).digest("hex");
    const got = (envelope.Signature || "").toLowerCase();
    let match = false;
    try {
      match = timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(got, "utf8"));
    } catch {
      match = false;
    }
    if (match) return { ok: true };
    return {
      ok: false,
      signingInput,
      expectedPrefix: expected.slice(0, 12),
      gotPrefix: got.slice(0, 12),
      gotLen: got.length,
    };
  }

  /**
   * Convert webhook messages to SyncMessage format and feed through
   * the existing processSyncResponse pipeline. This reuses all dedup,
   * filtering, normalization, quote parsing, and media extraction logic.
   */
  private processWebhookMessages(envelope: WebhookEnvelope): void {
    const messages = envelope.Data?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const syncMessages: SyncMessage[] = messages
      .filter(msg => !msg.isSelf)
      .map(msg => ({
        MsgId: msg.msgId,
        NewMsgId: msg.newMsgId,
        MsgType: msg.msgType,
        FromUserName: { string: msg.fromUser },
        ToUserName: { string: msg.toUser },
        // Prefer rawContent (full XML for non-text types) over text
        Content: { string: msg.rawContent || msg.text || "" },
        CreateTime: msg.createTime,
        PushContent: msg.pushContent || "",
        MsgSource: "",  // Not available in webhook format
        MsgSeq: 0,
      }));

    if (syncMessages.length === 0) return;

    // Wrap in a minimal SyncResponse to reuse the full pipeline
    const resp: SyncResponse = {
      Code: 0,
      Success: true,
      Message: "webhook",
      Data: {
        AddMsgs: syncMessages,
        ModContacts: [],
        ModUserInfos: [],
        ModUserImgs: [],
        DelContacts: null,
        FunctionSwitchs: [],
        Remarks: [],
        UserInfoExts: [],
        KeyBuf: { iLen: 0, buffer: this.synckey },
        Continue: null,
        ContinueFlag: null,
        Status: null,
        Time: null,
        UnknownCmdId: null,
      },
    };

    this.processSyncResponse(resp);
  }

  /**
   * Register our webhook URL with WCPP MAX via /Webhook/Set.
   */
  async registerWebhook(): Promise<boolean> {
    const authcode = this.config.authcode;
    if (!authcode) return false;

    const url = this.config.webhookUrl;
    if (!url) {
      this.log.error("WCPP MAX: webhookUrl is required to register webhook");
      return false;
    }

    const payload = {
      url,
      secret: this.config.webhookSecret || "",
      enabled: true,
      messageTypes: ["*"],
      includeSelfMessage: false,
      timeout: 5,
      retryCount: 3,
    };

    try {
      const res = await fetch(`${this.baseUrl}/api/Webhook/Set?authcode=${authcode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;
      if (data.Success) {
        this.log.info(`WCPP MAX: webhook registered → ${url}`);
        return true;
      }
      this.log.error(`WCPP MAX: failed to register webhook: ${data.Message}`);
      return false;
    } catch (e) {
      this.log.error("WCPP MAX: error registering webhook", e);
      return false;
    }
  }

  /**
   * Remove webhook from WCPP MAX via /Webhook/Remove.
   */
  async removeWebhook(): Promise<void> {
    const authcode = this.config.authcode;
    if (!authcode) return;
    try {
      await fetch(`${this.baseUrl}/api/Webhook/Remove?authcode=${authcode}`, { method: "POST" });
      this.log.info("WCPP MAX: webhook removed");
    } catch {
      // Best-effort cleanup
    }
  }

  // ──────────────────────────────────────────────
  // Unified connect/disconnect
  // ──────────────────────────────────────────────

  /**
   * Bring up inbound transports:
   *   - host set              → WebSocket push (base inbound + required for outbound)
   *   - webhookEnabled        → also start local webhook listener
   *   - host + webhookEnabled → auto-register the webhook with WCPPM via /Webhook/Set
   *   - no host + webhookEnabled → passive webhook-only mode; outbound will throw
   */
  connect(): void {
    if (this.config.host) {
      this.connectMaxWebSocket();
    }
    if (this.config.webhookEnabled) {
      this.startWebhookServer();
      if (this.config.host && this.config.webhookUrl) {
        this.registerWebhook();
      } else if (this.config.host) {
        this.log.info("WCPPM: webhookEnabled but no webhookUrl set; skipping /Webhook/Set (operator-managed)");
      } else {
        this.log.info("WCPPM: passive webhook-only mode; /Webhook/Set + /Login/Newinit are operator-managed");
      }
    }
  }

  disconnect(): void {
    this.disconnectMaxWebSocket();
    if (this.config.host && this.config.webhookEnabled) {
      this.removeWebhook();
    }
    this.stopWebhookServer();
  }

  // ──────────────────────────────────────────────
  // Send messages
  // ──────────────────────────────────────────────

  async sendText(to: string, text: string): Promise<boolean> {
    if (this.config.readOnly) {
      this.log.warn("WCPPM: read-only mode active, not sending message");
      return false;
    }

    const url = `${this.baseUrl}/api/Msg/SendTxt?${this.authQuery()}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ToWxid: to, Content: text, Type: 1 }),
      });
      const data = (await res.json()) as any;
      if (data.Code === 0 || data.Code === 200) return true;
      this.log.warn("WCPPM: SendTxt returned non-success", data);
      return false;
    } catch (e) {
      this.log.error("WCPPM: error sending text", e);
      return false;
    }
  }

  async sendImage(to: string, base64Data: string): Promise<boolean> {
    if (this.config.readOnly) {
      this.log.warn("WCPPM: read-only mode active, not sending image");
      return false;
    }

    const url = `${this.baseUrl}/message/SendImageNewMessage?${this.authQuery()}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          MsgItem: [{ ImageContent: base64Data, MsgType: 3, ToUserName: to }],
        }),
      });
      const data = (await res.json()) as any;
      return data.Code === 200;
    } catch (e) {
      this.log.error("WCPP: error sending image", e);
      return false;
    }
  }

  private buildAttachmentCandidate(
    kind: "voice" | "image" | "video",
    msgId: string,
  ): AttachmentCandidate {
    if (kind === "voice") {
      return {
        kind,
        mimeType: "audio/ogg",
        extension: ".ogg",
        fileName: `wechat-voice-${msgId}.ogg`,
        msgId,
      };
    }
    if (kind === "image") {
      return {
        kind,
        mimeType: "image/jpeg",
        extension: ".jpg",
        fileName: `wechat-image-${msgId}.jpg`,
        msgId,
      };
    }
    return {
      kind,
      mimeType: "video/mp4",
      extension: ".mp4",
      fileName: `wechat-video-${msgId}.mp4`,
      msgId,
    };
  }

  private async materializeMedia(
    download: (outputPath?: string) => Promise<{ buffer: Buffer | null; outputPath?: string; contentType: string | null }>,
    attachment: AttachmentCandidate,
    dir?: string,
  ): Promise<{ filePath: string; mimeType: string; fileName: string }> {
    const path = await import("path");
    const os = await import("os");
    const fs = await import("fs/promises");

    const baseDir = dir ?? path.join(os.tmpdir(), "wcppm-lob-media");
    await fs.mkdir(baseDir, { recursive: true });
    const filePath = path.join(baseDir, attachment.fileName);
    const result = await download(filePath);

    if (!result.outputPath && result.buffer) {
      await fs.writeFile(filePath, result.buffer);
    }

    return {
      filePath,
      mimeType: result.contentType ?? attachment.mimeType,
      fileName: attachment.fileName,
    };
  }

  private async downloadMediaEndpoint(
    endpoint: string,
    payload: Record<string, unknown>,
    outputPath?: string,
  ): Promise<MediaDownloadResult> {
    const url = `${this.baseUrl}${endpoint}?${this.authQuery()}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*" },
      body: JSON.stringify(payload),
    });

    const contentType = res.headers.get("content-type");
    if (!res.ok) {
      throw new Error(`WCPP: ${endpoint} HTTP ${res.status}`);
    }

    let buffer: Buffer | null = null;
    let responseJson: unknown;

    if (contentType?.includes("application/json")) {
      const data = await res.json() as any;
      responseJson = data;

      const candidates = [
        data?.Data,
        data?.data,
        data?.Data?.buffer,
        data?.Data?.base64,
        data?.Data?.Base64,
        data?.buffer,
        data?.base64,
        data?.Base64,
      ].filter(Boolean);

      const base64Candidate = candidates.find((v: unknown) => typeof v === "string" && /^[A-Za-z0-9+/=\r\n]+$/.test(v as string));
      if (typeof base64Candidate === "string") {
        buffer = Buffer.from(base64Candidate.replace(/\s+/g, ""), "base64");
      }
    } else {
      buffer = Buffer.from(await res.arrayBuffer());
    }

    if (outputPath && buffer) {
      const fs = await import("fs/promises");
      await fs.writeFile(outputPath, buffer);
      return { contentType, buffer, outputPath, responseJson, requestPayload: payload };
    }

    return { contentType, buffer, responseJson, requestPayload: payload };
  }

  async downloadVoice(message: SyncMessage | NormalizedMessage, outputPath?: string): Promise<VoiceDownloadResult> {
    const info = this.extractVoiceMessageInfo(message);
    if (!info) {
      throw new Error("WCPP: message is not a voice message (MsgType 34)");
    }
    if (!info.bufid || !info.fromUserName || info.length == null || info.msgId == null) {
      throw new Error("WCPP: voice message is missing required download fields (bufid/fromUserName/length/msgId)");
    }

    const result = await this.downloadMediaEndpoint("/Tools/DownloadVoice", {
      bufid: info.bufid,
      fromUserName: info.fromUserName,
      length: info.length,
      msgId: info.msgId,
    }, outputPath);

    return {
      contentType: result.contentType,
      buffer: result.buffer,
      outputPath: result.outputPath,
      responseJson: result.responseJson,
    };
  }

  async downloadImage(message: SyncMessage | NormalizedMessage, outputPath?: string): Promise<MediaDownloadResult> {
    const info = this.extractImageMessageInfo(message);
    if (!info) {
      throw new Error("WCPP: message is not an image message (MsgType 3)");
    }
    if (!info.fromUserName || info.msgId == null) {
      throw new Error("WCPP: image message is missing required fields (fromUserName/msgId)");
    }

    const payload: Record<string, unknown> = {
      fromUserName: info.fromUserName,
      msgId: info.msgId,
    };
    if (info.aesKey) payload.aesKey = info.aesKey;
    if (info.cdnMidImgUrl) payload.cdnMidImgUrl = info.cdnMidImgUrl;
    if (info.cdnBigImgUrl) payload.cdnBigImgUrl = info.cdnBigImgUrl;
    if (info.cdnThumbUrl) payload.cdnThumbUrl = info.cdnThumbUrl;
    if (info.md5) payload.md5 = info.md5;
    if (info.fileLength != null) payload.length = info.fileLength;

    return this.downloadMediaEndpoint("/Tools/DownloadImg", payload, outputPath);
  }

  async downloadVideo(message: SyncMessage | NormalizedMessage, outputPath?: string): Promise<MediaDownloadResult> {
    const info = this.extractVideoMessageInfo(message);
    if (!info) {
      throw new Error("WCPP: message is not a video message (MsgType 43/62)");
    }
    if (!info.fromUserName || info.msgId == null) {
      throw new Error("WCPP: video message is missing required fields (fromUserName/msgId)");
    }

    const payload: Record<string, unknown> = {
      fromUserName: info.fromUserName,
      msgId: info.msgId,
    };
    if (info.aesKey) payload.aesKey = info.aesKey;
    if (info.cdnVideoUrl) payload.cdnVideoUrl = info.cdnVideoUrl;
    if (info.cdnThumbUrl) payload.cdnThumbUrl = info.cdnThumbUrl;
    if (info.md5) payload.md5 = info.md5;
    if (info.newMd5) payload.newMd5 = info.newMd5;
    if (info.fileLength != null) payload.length = info.fileLength;
    if (info.playLengthSeconds != null) payload.playLength = info.playLengthSeconds;

    return this.downloadMediaEndpoint("/Tools/DownloadVideo", payload, outputPath);
  }

  resolveMedia(message: SyncMessage | NormalizedMessage): ResolvedMedia | null {
    const voice = this.extractVoiceMessageInfo(message);
    if (voice) {
      const attachment = this.buildAttachmentCandidate("voice", String(voice.msgId ?? "unknown"));
      return {
        kind: "voice",
        info: voice,
        attachment,
        download: (outputPath?: string) => this.downloadVoice(message, outputPath),
        materialize: (dir?: string) => this.materializeMedia((outputPath?: string) => this.downloadVoice(message, outputPath), attachment, dir),
      };
    }

    const image = this.extractImageMessageInfo(message);
    if (image) {
      const attachment = this.buildAttachmentCandidate("image", String(image.msgId ?? "unknown"));
      return {
        kind: "image",
        info: image,
        attachment,
        download: (outputPath?: string) => this.downloadImage(message, outputPath),
        materialize: (dir?: string) => this.materializeMedia((outputPath?: string) => this.downloadImage(message, outputPath), attachment, dir),
      };
    }

    const video = this.extractVideoMessageInfo(message);
    if (video) {
      const attachment = this.buildAttachmentCandidate("video", String(video.msgId ?? "unknown"));
      return {
        kind: "video",
        info: video,
        attachment,
        download: (outputPath?: string) => this.downloadVideo(message, outputPath),
        materialize: (dir?: string) => this.materializeMedia((outputPath?: string) => this.downloadVideo(message, outputPath), attachment, dir),
      };
    }

    return null;
  }

  isMediaMessage(message: SyncMessage | NormalizedMessage): boolean {
    return this.resolveMedia(message) !== null;
  }

  /**
   * Send a quoted/reply message (引用回复).
   * Requires WCPP MAX API.
   */
  async sendQuote(to: string, text: string, referMsgId: string, referToUserName?: string): Promise<boolean> {
    if (this.config.readOnly) {
      this.log.warn("WCPP: read-only mode active, not sending quote");
      return false;
    }

    // Quote API (WCPP MAX /api/Msg/Quote)
    // Fields: ToWxid, Fromusr (quoted sender), Displayname, NewMsgId, QuoteContent, MsgContent
    const url = `${this.baseUrl}/api/Msg/Quote?${this.authQuery()}`;
    const payload: Record<string, unknown> = {
      ToWxid: to,
      MsgContent: text,
      NewMsgId: referMsgId,
    };

    if (referToUserName) {
      payload.Fromusr = referToUserName;
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;
      if (data.Code === 0 || data.Code === 200) return true;
      this.log.warn("WCPP: Quote API returned non-success", data);
      return false;
    } catch (e) {
      this.log.error("WCPP: error sending quote", e);
      return false;
    }
  }

  // ──────────────────────────────────────────────
  // Contact helpers
  // ──────────────────────────────────────────────

  async getGroupMemberNickname(groupId: string, memberWxid: string): Promise<string | null> {
    // Check cache first (from Sync contacts)
    const cached = this.contactCache.get(memberWxid);
    if (cached?.NickName?.string) return cached.NickName.string;

    try {
      const res = await fetch(`${this.baseUrl}/group/GetChatroomMemberDetail?${this.authQuery()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ChatRoomName: groupId }),
      });
      const data = (await res.json()) as any;
      if (data.Code === 200) {
        const members = data.Data?.member_data?.chatroom_member_list ?? [];
        for (const m of members) {
          if (m.user_name === memberWxid) return m.nick_name;
        }
      }
      return null;
    } catch { return null; }
  }

  async getContactList(): Promise<string[] | null> {
    try {
      const res = await fetch(`${this.baseUrl}/friend/GetContactList?${this.authQuery()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ CurrentChatRoomContactSeq: 0, CurrentWxcontactSeq: 0 }),
      });
      const data = (await res.json()) as any;
      if (data.Code === 200 && data.Data) {
        return data.Data.ContactList?.contactUsernameList ?? [];
      }
      return null;
    } catch { return null; }
  }
}
