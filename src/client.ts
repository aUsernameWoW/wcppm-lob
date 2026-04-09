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
  /** "ws" = WebSocket (standard WCPP), "sync" = HTTP polling (WCPP MAX) */
  syncMode?: "ws" | "sync";
  /** WCPP MAX authcode (used instead of key for /api/* endpoints) */
  authcode?: string;
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
  /** Raw underlying message (WS or Sync format) */
  raw: unknown;
}

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
  public syncMode: "ws" | "sync";
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
    // For sync mode with authcode, we might already be "logged in"
    if (this.syncMode === "sync" && this.config.authcode) {
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
    const allowTypes = this.config.allowMsgTypes ?? [1, 3, 34, 47, 49];
    const passRevoke = this.config.passRevokemsg ?? true;
    const maxAge = this.config.maxMessageAge ?? 180;

    for (const msg of resp.Data.AddMsgs ?? []) {
      const msgIdStr = String(msg.NewMsgId);

      // Dedup
      if (this.seenMsgIds.has(msgIdStr)) continue;

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
      this.seenMsgIds.add(msgIdStr);
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

    // For MsgType 49 (app/xml), extract the <title> as the display text
    if (msg.MsgType === 49) {
      const titleMatch = content.match(/<title>([^<]+)<\/title>/);
      if (titleMatch) {
        const referType = content.match(/<refermsg>[\s\S]*?<type>(\d+)<\/type>/);
        if (referType) {
          text = `[引用] ${titleMatch[1]}`;
        } else {
          text = titleMatch[1];
        }
      }
    }

    // For MsgType 10002 revokemsg
    if (msg.MsgType === 10002) {
      const revokeMatch = content.match(/replacemsg><!\[CDATA\[(.*?)\]\]>/);
      if (revokeMatch) {
        text = `[撤回] ${revokeMatch[1]}`;
      }
    }

    return {
      msgId: String(msg.NewMsgId),
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
  // Unified connect/disconnect
  // ──────────────────────────────────────────────

  connect(): void {
    if (this.syncMode === "sync") {
      this.startSyncPolling();
    } else {
      this.connectWebSocket();
    }
  }

  disconnect(): void {
    this.stopSyncPolling();
    this.disconnectWebSocket();
  }

  // ──────────────────────────────────────────────
  // Send messages
  // ──────────────────────────────────────────────

  async sendText(to: string, text: string): Promise<boolean> {
    if (this.config.readOnly) {
      this.log.warn("WCPP: read-only mode active, not sending message");
      return false;
    }

    const authParam = this.syncMode === "sync"
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

    const authParam = this.syncMode === "sync"
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

  // ──────────────────────────────────────────────
  // Contact helpers
  // ──────────────────────────────────────────────

  async getGroupMemberNickname(groupId: string, memberWxid: string): Promise<string | null> {
    // Check cache first (from Sync contacts)
    const cached = this.contactCache.get(memberWxid);
    if (cached?.NickName?.string) return cached.NickName.string;

    const authParam = this.syncMode === "sync"
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
    const authParam = this.syncMode === "sync"
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
