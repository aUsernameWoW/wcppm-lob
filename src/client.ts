/**
 * WeChatPadPro API client — wraps all REST + WS interactions.
 *
 * Reference: AstrBot wechatpadpro adapter + WeChatPadPro Swagger docs
 */

import WebSocket from "ws";
import type { Logger } from "openclaw/plugin-sdk/channel-core";

export interface WcppConfig {
  adminKey: string;
  host: string;
  port: number;
  authKey?: string;
  wxid?: string;
  proxy?: string;
  replyWithMention?: boolean;
}

export interface WcppCredentials {
  authKey: string;
  wxid: string;
}

/** Raw WS message from WeChatPadPro */
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

export class WcppClient {
  public authKey: string | null;
  public wxid: string | null;
  private baseUrl: string;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _onMessage: ((msg: WcppRawMessage) => void) | null = null;

  constructor(
    private config: WcppConfig,
    private log: Logger,
  ) {
    this.authKey = config.authKey ?? null;
    this.wxid = config.wxid ?? null;
    this.baseUrl = `http://${config.host}:${config.port}`;
  }

  // ──────────────────────────────────────────────
  // Auth & Login
  // ──────────────────────────────────────────────

  async generateAuthKey(): Promise<string | null> {
    const url = `${this.baseUrl}/admin/GenAuthKey1?key=${this.config.adminKey}`;
    const payload = { Count: 1, Days: 365 };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;

      if (data.Code === 200 && data.Data) {
        // New API returns { authKeys: [...] }, old returns [...]
        const key = this.extractAuthKey(data.Data);
        if (key) {
          this.authKey = key;
          this.log.info("WeChatPadPro: auth key generated successfully");
          return key;
        }
      }
      this.log.error("WeChatPadPro: failed to generate auth key", data);
      return null;
    } catch (e) {
      this.log.error("WeChatPadPro: error generating auth key", e);
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
      const url = `${this.baseUrl}/login/GetLoginStatus?key=${this.authKey}`;
      const res = await fetch(url);
      const data = (await res.json()) as any;

      if (data.Code === 200 && data.Data?.loginState === 1) return true;
      if (data.Code === 300) return false; // logged out
      if (data.Code === -2) {
        this.authKey = null; // invalid key
        return false;
      }
      return false;
    } catch {
      return false;
    }
  }

  async getLoginQrCode(): Promise<string | null> {
    if (!this.authKey) return null;

    const url = `${this.baseUrl}/login/GetLoginQrCodeNew?key=${this.authKey}`;
    const payload: Record<string, unknown> = { Check: false };
    if (this.config.proxy) payload.Proxy = this.config.proxy;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;

      if (data.Code === 200 && data.Data?.QrCodeUrl) {
        return data.Data.QrCodeUrl;
      }
      this.log.error("WeChatPadPro: failed to get QR code", data);
      return null;
    } catch (e) {
      this.log.error("WeChatPadPro: error getting QR code", e);
      return null;
    }
  }

  async checkLoginStatus(): Promise<WcppCredentials | null> {
    if (!this.authKey) return null;

    const url = `${this.baseUrl}/login/CheckLoginStatus?key=${this.authKey}`;

    for (let i = 0; i < 36; i++) {
      try {
        const res = await fetch(url);
        const data = (await res.json()) as any;

        if (data.Code === 200 && data.Data?.state != null) {
          const state = data.Data.state;
          if (state === 2) {
            this.wxid = data.Data.wxid;
            this.log.info(`WeChatPadPro: login successful, wxid=${this.wxid}`);
            return { authKey: this.authKey, wxid: this.wxid! };
          }
          if (state === -2) {
            this.log.error("WeChatPadPro: QR code expired");
            return null;
          }
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    this.log.error("WeChatPadPro: login timed out");
    return null;
  }

  async wakeUpLogin(): Promise<boolean> {
    if (!this.authKey) return false;

    try {
      const url = `${this.baseUrl}/login/WakeUpLogin?key=${this.authKey}`;
      const res = await fetch(url, { method: "POST" });
      const data = (await res.json()) as any;
      return data.Code === 200;
    } catch {
      return false;
    }
  }

  // ──────────────────────────────────────────────
  // WebSocket
  // ──────────────────────────────────────────────

  get onMessage() {
    return this._onMessage;
  }

  set onMessage(handler: ((msg: WcppRawMessage) => void) | null) {
    this._onMessage = handler;
  }

  connectWebSocket(): void {
    if (!this.authKey) {
      this.log.error("WeChatPadPro: cannot connect WS without auth key");
      return;
    }

    const wsUrl = `ws://${this.config.host}:${this.config.port}/ws/GetSyncMsg?key=${this.authKey}`;
    this.log.info(`WeChatPadPro: connecting WebSocket to ${this.config.host}:${this.config.port}`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      this.log.info("WeChatPadPro: WebSocket connected");
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      try {
        const parsed = JSON.parse(raw.toString()) as WcppRawMessage;
        if (parsed.msg_id != null && parsed.from_user_name?.str) {
          this._onMessage?.(parsed);
        }
      } catch {
        // ignore non-JSON or malformed messages
      }
    });

    this.ws.on("close", (code, reason) => {
      this.log.warn(`WeChatPadPro: WebSocket closed (code=${code}), reconnecting in 5s...`);
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.log.error("WeChatPadPro: WebSocket error", err);
    });

    // Ping/pong to keep alive
    const pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30_000);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 5000);
  }

  disconnectWebSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  // ──────────────────────────────────────────────
  // Send messages
  // ──────────────────────────────────────────────

  async sendText(to: string, text: string): Promise<boolean> {
    if (!this.authKey) return false;

    const url = `${this.baseUrl}/message/SendTextMessage?key=${this.authKey}`;
    const payload = {
      MsgItem: [
        { MsgType: 1, TextContent: text, ToUserName: to },
      ],
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;
      return data.Code === 200;
    } catch (e) {
      this.log.error("WeChatPadPro: error sending text", e);
      return false;
    }
  }

  async sendImage(to: string, base64Data: string): Promise<boolean> {
    if (!this.authKey) return false;

    const url = `${this.baseUrl}/message/SendImageNewMessage?key=${this.authKey}`;
    const payload = {
      MsgItem: [
        { ImageContent: base64Data, MsgType: 3, ToUserName: to },
      ],
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;
      return data.Code === 200;
    } catch (e) {
      this.log.error("WeChatPadPro: error sending image", e);
      return false;
    }
  }

  async sendEmoji(to: string, md5: string, md5Len: string): Promise<boolean> {
    if (!this.authKey) return false;

    const url = `${this.baseUrl}/message/SendEmojiMessage?key=${this.authKey}`;
    const payload = {
      EmojiList: [{ EmojiMd5: md5, EmojiSize: md5Len, ToUserName: to }],
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;
      return data.Code === 200;
    } catch (e) {
      this.log.error("WeChatPadPro: error sending emoji", e);
      return false;
    }
  }

  // ──────────────────────────────────────────────
  // Contact helpers
  // ──────────────────────────────────────────────

  async getGroupMemberNickname(
    groupId: string,
    memberWxid: string,
  ): Promise<string | null> {
    if (!this.authKey) return null;

    const url = `${this.baseUrl}/group/GetChatroomMemberDetail?key=${this.authKey}`;
    const payload = { ChatRoomName: groupId };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;

      if (data.Code === 200) {
        const members =
          data.Data?.member_data?.chatroom_member_list ?? [];
        for (const m of members) {
          if (m.user_name === memberWxid) return m.nick_name;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async getContactList(): Promise<string[] | null> {
    if (!this.authKey) return null;

    const url = `${this.baseUrl}/friend/GetContactList?key=${this.authKey}`;
    const payload = { CurrentChatRoomContactSeq: 0, CurrentWxcontactSeq: 0 };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;

      if (data.Code === 200 && data.Data) {
        return data.Data.ContactList?.contactUsernameList ?? [];
      }
      return null;
    } catch {
      return null;
    }
  }

  // ──────────────────────────────────────────────
  // Full login orchestration
  // ──────────────────────────────────────────────

  /**
   * Run the full login flow: check online → generate key if needed → QR code → poll status.
   * Returns credentials on success.
   */
  async login(): Promise<WcppCredentials | null> {
    // Try online check first
    const isOnline = await this.checkOnlineStatus();
    if (isOnline && this.authKey && this.wxid) {
      this.log.info("WeChatPadPro: already online, skipping login");
      return { authKey: this.authKey, wxid: this.wxid };
    }

    // Try wake-up if we have credentials
    if (this.authKey && this.wxid) {
      this.log.info("WeChatPadPro: attempting wake-up login...");
      const woke = await this.wakeUpLogin();
      if (woke) {
        const online = await this.checkOnlineStatus();
        if (online) {
          this.log.info("WeChatPadPro: wake-up login successful");
          return { authKey: this.authKey, wxid: this.wxid };
        }
      }
    }

    // Generate auth key if needed
    if (!this.authKey) {
      this.log.info("WeChatPadPro: generating new auth key...");
      const key = await this.generateAuthKey();
      if (!key) return null;
    }

    // Get QR code
    this.log.info("WeChatPadPro: fetching login QR code...");
    const qrUrl = await this.getLoginQrCode();
    if (!qrUrl) return null;

    this.log.info(`WeChatPadPro: scan this QR code to login: ${qrUrl}`);

    // Poll for login
    const creds = await this.checkLoginStatus();
    return creds;
  }
}
