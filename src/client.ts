/**
 * WeChatPadPro / WeChatPadProMAX API client.
 *
 * Supports two modes:
 * 1. WebSocket (standard WeChatPadPro) — `/ws/GetSyncMsg`
 * 2. HTTP Sync polling (WeChatPadProMAX) — `/api/Msg/Sync`
 *
 * Mode is determined by `syncMode` in config.
 */

import WebSocket from "ws";
import type { Logger } from "openclaw/plugin-sdk/channel-core";

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────

export interface WcppConfig {
  adminKey: string;
  host: string;
  port: number;
  authKey?: string;
  wxid?: string;
  proxy?: string;
  replyWithMention?: boolean;
  /** 
   * "ws" = WebSocket (standard WCPP /ws/GetSyncMsg)
   * "sync" = HTTP polling (WCPP MAX /api/Msg/Sync)
   * "websocket" = WebSocket push (WCPP MAX /ws/sync)
   */
  syncMode?: "ws" | "sync" | "websocket";
  /** WCPP MAX authcode (used instead of key for /api/* endpoints) */
  authcode?: string;
  /** Custom WebSocket URL (optional, for WCPP MAX websocket mode) */
  wsUrl?: string;
  /** Sync polling interval in ms (default 5000) */
  syncInterval?: number;
  /** Nurturing mode: receive-only, no sending (default false for safety during initial period) */
  readOnly?: boolean;
  /** Allow these MsgTypes through (default: [1, 3, 34, 47, 49]) */
  allowMsgTypes?: number[];
  /** Also pass through revokemsg from MsgType 10002? (default true) */
  passRevokemsg?: boolean;
  /** Max age for messages in seconds — drop older (default 180) */
  maxMessageAge?: number;
}

export interface WcppCredentials {
  authKey: string;
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

/** Raw WS message from standard WeChatPadPro */
export interface WcppRawMessage {
  msg_id: number;
  new_msg_id?: string;
  from_user_name: { str: string };
  to_user_name: { str: string };
  content: { str: string };
  push_content?: string;
  msg_source?: string;
  msg_type: number;
  create_time: number;
}

// ──────────────────────────────────────────────
// Client
// ──────────────────────────────────────────────

type MessageHandler = (msg: NormalizedMessage) => void;

export class WcppClient {
  public authKey: string | null;
  public wxid: string | null;
  public syncMode: "ws" | "sync" | "websocket";
  private baseUrl: string;

  // WS state
  private ws: WebSocket | null = null;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Sync polling state
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private synckey: string; // base64 KeyBuf.buffer for next poll
  private continueFlag: number;
  private seenMsgIds: Set<string> = new Set();
  private readonly SEEN_MSG_ID_MAX = 10000;
  private syncRunning = false;

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
    this.authKey = config.authKey ?? null;
    this.wxid = config.wxid ?? null;
    this.syncMode = config.syncMode ?? "ws";
    this.baseUrl = `http://${config.host}:${config.port}`;
    this.synckey = "string"; // initial value for first Sync call
    this.continueFlag = 0;
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
  // Auth & Login (standard WCPP endpoints)
  // ──────────────────────────────────────────────

  async generateAuthKey(): Promise<string | null> {
    const url = `${this.baseUrl}/admin/GenAuthKey1?key=${this.config.adminKey}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Count: 1, Days: 365 }),
      });
      const data = (await res.json()) as any;
      if (data.Code === 200 && data.Data) {
        const key = this.extractAuthKey(data.Data);
        if (key) { this.authKey = key; return key; }
      }
      return null;
    } catch (e) {
      this.log.error("WCPP: error generating auth key", e);
      return null;
    }
  }

  private extractAuthKey(data: unknown): string | null {
    if (Array.isArray(data) && data.length > 0) return data[0];
    if (typeof data === "object" && data !== null) {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.authKeys) && obj.authKeys.length > 0)
        return obj.authKeys[0] as string;
    }
    return null;
  }

  async checkOnlineStatus(): Promise<boolean> {
    if (!this.authKey) return false;
    try {
      const res = await fetch(`${this.baseUrl}/login/GetLoginStatus?key=${this.authKey}`);
      const data = (await res.json()) as any;
      if (data.Code === 200 && data.Data?.loginState === 1) return true;
      if (data.Code === -2) this.authKey = null;
      return false;
    } catch { return false; }
  }

  async getLoginQrCode(): Promise<string | null> {
    if (!this.authKey) return null;
    const payload: Record<string, unknown> = { Check: false };
    if (this.config.proxy) payload.Proxy = this.config.proxy;
    try {
      const res = await fetch(`${this.baseUrl}/login/GetLoginQrCodeNew?key=${this.authKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;
      return data.Code === 200 ? data.Data?.QrCodeUrl ?? null : null;
    } catch (e) {
      this.log.error("WCPP: error getting QR code", e);
      return null;
    }
  }

  async checkLoginStatus(): Promise<WcppCredentials | null> {
    if (!this.authKey) return null;
    for (let i = 0; i < 36; i++) {
      try {
        const res = await fetch(`${this.baseUrl}/login/CheckLoginStatus?key=${this.authKey}`);
        const data = (await res.json()) as any;
        if (data.Code === 200 && data.Data?.state != null) {
          if (data.Data.state === 2) {
            this.wxid = data.Data.wxid;
            return { authKey: this.authKey, wxid: this.wxid! };
          }
          if (data.Data.state === -2) return null;
        }
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 5000));
    }
    return null;
  }

  async wakeUpLogin(): Promise<boolean> {
    if (!this.authKey) return false;
    try {
      const res = await fetch(`${this.baseUrl}/login/WakeUpLogin?key=${this.authKey}`, { method: "POST" });
      const data = (await res.json()) as any;
      return data.Code === 200;
    } catch { return false; }
  }

  /**
   * Full login orchestration. Returns credentials on success.
   */
  async login(): Promise<WcppCredentials | null> {
    // For sync/websocket mode with authcode, verify via a test Sync request
    if ((this.syncMode === "sync" || this.syncMode === "websocket") && this.config.authcode) {
      // Try a test Sync to verify the authcode works
      const testResult = await this.doSyncRequest();
      if (testResult && testResult.Success) {
        // Extract wxid from ModUserInfos
        if (testResult.Data?.ModUserInfos?.[0]) {
          this.wxid = testResult.Data.ModUserInfos[0].UserName.string;
          this.log.info(`WCPP MAX: sync test OK, wxid=${this.wxid}`);
          // Seed the contact cache
          this.ingestContacts(testResult);
          // Seed synckey from response
          if (testResult.Data.KeyBuf?.buffer) {
            this.synckey = testResult.Data.KeyBuf.buffer;
          }
          return { authKey: this.config.authcode!, wxid: this.wxid! };
        }
        this.log.info("WCPP MAX: sync test OK but no ModUserInfos");
        return { authKey: this.config.authcode!, wxid: this.wxid ?? "unknown" };
      }
      this.log.error("WCPP MAX: sync test failed, authcode may be invalid");
      return null;
    }

    // Standard WCPP login flow
    if (await this.checkOnlineStatus() && this.authKey && this.wxid) {
      return { authKey: this.authKey, wxid: this.wxid };
    }

    if (this.authKey && this.wxid) {
      const woke = await this.wakeUpLogin();
      if (woke && await this.checkOnlineStatus()) {
        return { authKey: this.authKey, wxid: this.wxid };
      }
    }

    if (!this.authKey) {
      const key = await this.generateAuthKey();
      if (!key) return null;
    }

    const qrUrl = await this.getLoginQrCode();
    if (!qrUrl) return null;
    this.log.info(`WCPP: scan QR code to login: ${qrUrl}`);
    return this.checkLoginStatus();
  }

  // ──────────────────────────────────────────────
  // Sync polling (WCPP MAX)
  // ──────────────────────────────────────────────

  private async doSyncRequest(): Promise<SyncResponse | null> {
    const authcode = this.config.authcode ?? this.authKey;
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
   * Start the Sync polling loop.
   */
  startSyncPolling(): void {
    if (this.syncRunning) return;
    this.syncRunning = true;
    this.log.info("WCPP MAX: starting Sync polling loop");
    this.pollOnce();
  }

  stopSyncPolling(): void {
    this.syncRunning = false;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.log.info("WCPP MAX: stopped Sync polling");
  }

  private async pollOnce(): Promise<void> {
    if (!this.syncRunning) return;

    try {
      const resp = await this.doSyncRequest();
      if (resp?.Success && resp.Data) {
        this.processSyncResponse(resp);

        // If ContinueFlag != 0, there's more data — poll again immediately
        if (this.continueFlag !== 0) {
          this.log.debug("WCPP MAX: ContinueFlag != 0, polling again immediately");
          setImmediate(() => this.pollOnce());
          return;
        }
      } else if (resp && !resp.Success) {
        this.log.warn(`WCPP MAX: Sync returned !Success: Code=${resp.Code} Message=${resp.Message}`);
      }
    } catch (e) {
      this.log.error("WCPP MAX: poll error", e);
    }

    // Schedule next poll
    const interval = this.config.syncInterval ?? 5000;
    this.syncTimer = setTimeout(() => this.pollOnce(), interval);
  }

  // ──────────────────────────────────────────────
  // WebSocket (standard WCPP)
  // ──────────────────────────────────────────────

  connectWebSocket(): void {
    if (!this.authKey) {
      this.log.error("WCPP: cannot connect WS without auth key");
      return;
    }

    const wsUrl = `ws://${this.config.host}:${this.config.port}/ws/GetSyncMsg?key=${this.authKey}`;
    this.log.info(`WCPP: connecting WebSocket to ${this.config.host}:${this.config.port}`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => this.log.info("WCPP: WebSocket connected"));

    this.ws.on("message", (raw: WebSocket.Data) => {
      try {
        const parsed = JSON.parse(raw.toString()) as WcppRawMessage;
        if (parsed.msg_id != null && parsed.from_user_name?.str) {
          const normalized = this.normalizeWsMessage(parsed);
          if (normalized) this._onMessage?.(normalized);
        }
      } catch { /* ignore */ }
    });

    this.ws.on("close", (code) => {
      this.log.warn(`WCPP: WebSocket closed (code=${code}), reconnecting in 5s...`);
      this.scheduleWsReconnect();
    });

    this.ws.on("error", (err) => this.log.error("WCPP: WebSocket error", err));

    // Keepalive
    const pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30_000);
  }

  private normalizeWsMessage(msg: WcppRawMessage): NormalizedMessage | null {
    const fromUser = msg.from_user_name?.str ?? "";
    const content = msg.content?.str ?? "";
    const pushContent = msg.push_content ?? "";
    const msgSource = msg.msg_source ?? "";

    if (fromUser === this.wxid) return null; // drop own messages

    const isGroup = fromUser.includes("@chatroom");
    let senderWxid = fromUser;
    let text = content;
    let groupId: string | null = null;
    let isAtBot = false;

    if (isGroup) {
      groupId = fromUser;
      const colonIdx = content.indexOf(":\n");
      if (colonIdx > 0) {
        senderWxid = content.substring(0, colonIdx);
        text = content.substring(colonIdx + 2);
      }
      if (this.wxid) {
        isAtBot =
          msgSource.includes(`<atuserlist>${this.wxid}</atuserlist>`) ||
          msgSource.includes(`<atuserlist>${this.wxid},`) ||
          msgSource.includes(`,${this.wxid}</atuserlist>`);
      }
    }

    const quote = msg.msg_type === 49 ? this.parseQuoteMessage(text) : null;

    text = this.formatInboundDisplayText(msg.msg_type, text);

    return {
      msgId: String(msg.new_msg_id ?? msg.msg_id),
      fromUser,
      toUser: msg.to_user_name?.str ?? "",
      msgType: msg.msg_type,
      content,
      pushContent,
      msgSource,
      createTime: msg.create_time,
      senderWxid,
      text,
      isGroup,
      groupId,
      isAtBot,
      quote,
      raw: msg,
    };
  }

  private scheduleWsReconnect(): void {
    if (this.wsReconnectTimer) return;
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      this.connectWebSocket();
    }, 5000);
  }

  disconnectWebSocket(): void {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  // ──────────────────────────────────────────────
  // WebSocket for WCPP MAX (push mode)
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

    this.maxWs.on("open", () => this.log.info("WCPP MAX: WebSocket connected"));

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
  // Unified connect/disconnect
  // ──────────────────────────────────────────────

  connect(): void {
    if (this.syncMode === "sync") {
      this.startSyncPolling();
    } else if (this.syncMode === "websocket") {
      this.connectMaxWebSocket();
    } else {
      this.connectWebSocket();
    }
  }

  disconnect(): void {
    this.stopSyncPolling();
    this.disconnectWebSocket();
    this.disconnectMaxWebSocket();
  }

  // ──────────────────────────────────────────────
  // Send messages
  // ──────────────────────────────────────────────

  async sendText(to: string, text: string): Promise<boolean> {
    if (this.config.readOnly) {
      this.log.warn("WCPP: read-only mode active, not sending message");
      return false;
    }

    const authParam = (this.syncMode === "sync" || this.syncMode === "websocket")
      ? `authcode=${this.config.authcode}`
      : `key=${this.authKey}`;

    // Try MAX endpoint first
    const maxUrl = `${this.baseUrl}/api/Msg/SendTxt?${authParam}`;
    const maxPayload = {
      ToUserName: to,
      Content: text,
    };

    try {
      const res = await fetch(maxUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(maxPayload),
      });
      const data = (await res.json()) as any;
      if (data.Code === 0 || data.Code === 200) return true;
      // Fall through to standard endpoint
    } catch {
      // Fall through to standard endpoint
    }

    // Standard WCPP endpoint
    const stdUrl = `${this.baseUrl}/message/SendTextMessage?${authParam}`;
    try {
      const res = await fetch(stdUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          MsgItem: [{ MsgType: 1, TextContent: text, ToUserName: to }],
        }),
      });
      const data = (await res.json()) as any;
      return data.Code === 200;
    } catch (e) {
      this.log.error("WCPP: error sending text", e);
      return false;
    }
  }

  async sendImage(to: string, base64Data: string): Promise<boolean> {
    if (this.config.readOnly) {
      this.log.warn("WCPP: read-only mode active, not sending image");
      return false;
    }

    const authParam = (this.syncMode === "sync" || this.syncMode === "websocket")
      ? `authcode=${this.config.authcode}`
      : `key=${this.authKey}`;
    const url = `${this.baseUrl}/message/SendImageNewMessage?${authParam}`;

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
    const authParam = (this.syncMode === "sync" || this.syncMode === "websocket")
      ? `authcode=${this.config.authcode}`
      : `key=${this.authKey}`;
    const url = `${this.baseUrl}${endpoint}?${authParam}`;

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

    // Quote API is only available in MAX mode via /api/Msg/Quote
    const authParam = (this.syncMode === "sync" || this.syncMode === "websocket")
      ? `authcode=${this.config.authcode}`
      : `key=${this.authKey}`;
    
    const url = `${this.baseUrl}/api/Msg/Quote?${authParam}`;
    const payload: Record<string, unknown> = {
      ToUserName: to,
      Content: text,
      ReferMsgId: referMsgId,
    };
    
    // ReferToUserName may be required for group quotes
    if (referToUserName) {
      payload.ReferToUserName = referToUserName;
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

    const authParam = (this.syncMode === "sync" || this.syncMode === "websocket")
      ? `authcode=${this.config.authcode}`
      : `key=${this.authKey}`;

    try {
      const res = await fetch(`${this.baseUrl}/group/GetChatroomMemberDetail?${authParam}`, {
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
    const authParam = (this.syncMode === "sync" || this.syncMode === "websocket")
      ? `authcode=${this.config.authcode}`
      : `key=${this.authKey}`;

    try {
      const res = await fetch(`${this.baseUrl}/friend/GetContactList?${authParam}`, {
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
