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
import { fetch as undiciFetch } from "undici";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "../shared/logger.js";
import { buildProxyTransport, type ProxyTransport } from "./proxy.js";
import { makeRng } from "./rng.js";
import { fileExtToMime, safeFileName } from "./media-meta.js";

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────

/**
 * Randomized retry policy for the CDN image download (`/Tools/CdnDownloadImage`).
 * The CDN object isn't always ready the instant the push arrives, so we retry a
 * randomized number of times with a jittered backoff. A fixed `randomSeed`
 * reproduces the exact sequence (debugging only — production should leave it
 * unset so the cadence is unpredictable). All fields are resolved (no optionals)
 * by config.ts before reaching the client.
 */
export interface ImageRetryConfig {
  /** Lower bound (inclusive) of total attempts, counting the first try. */
  minAttempts: number;
  /** Upper bound (inclusive) of total attempts; the count is random in [min,max]. */
  maxAttempts: number;
  /** Backoff baseline in ms, before jitter. */
  baseDelayMs: number;
  /** Per-retry delay = baseDelayMs × (1 ± jitterPct). e.g. 0.3 → ±30%. */
  jitterPct: number;
  /** Seed for reproducible runs; null/undefined → Math.random (unpredictable). */
  randomSeed?: number | string | null;
}

export interface WcppConfig {
  /** WCPPM server host. Required for outbound + WS; may be empty for passive webhook-only receivers. */
  host: string;
  port: number;
  /** WCPPM authcode. Required whenever host is set. */
  authcode?: string;
  /** Cached self wxid (optional; auto-detected from the WS envelope or Sync ModUserInfos). */
  wxid?: string;
  /**
   * Proxy URL for outbound HTTP + WS (e.g. `http://host:port`,
   * `socks5://user:pass@host:port`). **Empty/unset = explicit direct
   * connection** that bypasses any process-global env proxy (OpenClaw installs
   * a global undici EnvHttpProxyAgent — see ./proxy.ts for why empty ≠ no-op).
   */
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
  /** Randomized CDN image-download retry policy (resolved by config.ts). */
  imageRetry?: ImageRetryConfig;
}

/** Built-in defaults for ImageRetryConfig — used when config omits the block. */
export const DEFAULT_IMAGE_RETRY: ImageRetryConfig = {
  minAttempts: 4,
  maxAttempts: 7,
  baseDelayMs: 1500,
  jitterPct: 0.3,
  randomSeed: null,
};

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
    // All payload arrays are OPTIONAL: the "当前未有新消息" (no new messages)
    // response omits every one of them and instead carries `CmdList:{Count:0}`.
    AddMsgs?: SyncMessage[];
    ModContacts?: SyncContact[];
    ModUserInfos?: SyncUserInfo[];
    ModUserImgs?: unknown[];
    DelContacts?: unknown[] | null;
    FunctionSwitchs?: unknown[];
    Remarks?: unknown[];
    UserInfoExts?: unknown[];
    /** Empty-batch marker on a "no new messages" response (no AddMsgs present). */
    CmdList?: { Count: number };
    Ret?: number;
    /** Base64-encoded protobuf — this IS the Synckey for next request */
    KeyBuf?: { iLen: number; buffer: string };
    Continue?: number | null;
    /**
     * A status bitmask, NOT a reliable "more data" signal: the empty
     * "no new messages" response still sets it non-zero (e.g. 256). Treat it
     * as "more backlog" only when the same response actually carried AddMsgs
     * (see forceSync's hasMore).
     */
    ContinueFlag?: number | null;
    Status?: number | null;
    /** Server timestamp. Capital `Time` on full responses; lowercase `time` on the empty one. */
    Time?: number | null;
    UnknownCmdId?: string | null;
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
 *
 * The outer wrapper is `{ Code, Success, Message, Data: { syncData | data, … } }`.
 * Verified by live capture (2026-06-07): the inner `syncData` is the SyncResponse
 * **Data payload directly** — `AddMsgs`/`ModContacts`/`ModUserInfos`/… sit at its
 * top level and it carries NO `.Success`/`.Data` of its own. (An older shape
 * nested a full `SyncResponse` under `data`; `handleWsMessage` tolerates both.)
 */
interface MaxWsEnvelope {
  Code: number;
  Success: boolean;
  Message?: string;
  Data?: {
    syncData?: SyncResponse["Data"] | SyncResponse;
    data?: SyncResponse["Data"] | SyncResponse;
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
 *
 * NOTE: the webhook payload shape depends on the WCPPM server's webhook config.
 *  - DOORBELL mode (live capture 2026-06-07): `{ MessageType: "sync_message",
 *    Data: {} }` with EMPTY `Data` — a signal only; the messages arrive over the
 *    WS push, so `processWebhookMessages` is a no-op.
 *  - INLINE mode (some deployments, incl. the current multi-instance one): the
 *    webhook carries the full `Data.messages[]` — typically the SAME messages as
 *    the WS push, a few seconds later. These are deduped against the WS copy by
 *    the shared `seenMsgIds` set, so the webhook acts as a redundant backup path.
 * Either way we deliberately do NOT Sync in response to a webhook (auto-dispatch
 * with no demand is the banned ban-trigger pattern — see CLAUDE.md Account Safety).
 */
export interface WebhookEnvelope {
  MessageType: string;
  Signature: string;
  Timestamp: number;
  Wxid: string;
  IsSelf: boolean;
  Data: {
    messages?: WebhookMessage[];
  };
}

/**
 * Verify a webhook envelope's HMAC signature against `secret`. Pure (no instance
 * state) so both the in-client webhook server and the shared webhook listener can
 * use it. The signing input is `${Wxid}:${MessageType}:${Timestamp}`.
 */
export function verifyWebhookSignature(
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

export interface FileMessageInfo {
  msgId: number | null;
  fromUserName: string | null;
  /** `<appmsg appid="…">` — passed as DownloadFile `appID` (may be empty). */
  appId: string | null;
  /** `<attachid>` — the `@cdn_…` token. Absent on the type-74 placeholder. */
  attachId: string | null;
  cdnAttachUrl: string | null;
  aesKey: string | null;
  /** `<totallen>` — total file size in bytes (DownloadFile `dataLen`). */
  totalLen: number | null;
  fileExt: string | null;
  /** `<title>` — the display file name (e.g. "症状.docx"). */
  title: string | null;
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
  kind: "voice" | "image" | "video" | "file";
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
    }
  | {
      kind: "file";
      info: FileMessageInfo;
      attachment: AttachmentCandidate;
      download: (outputPath?: string) => Promise<MediaDownloadResult>;
      materialize: (dir?: string) => Promise<{ filePath: string; mimeType: string; fileName: string }>;
    };

// ──────────────────────────────────────────────
// Pure media-download helpers (exported for unit tests)
// ──────────────────────────────────────────────

/**
 * Extract the binary payload from the MAX server's unified download JSON. The
 * bytes land at varying depths/keys across endpoints — CdnDownloadImage returns
 * base64 at `Data.Image`, others at `Data.data.buffer` — so we deep-scan for the
 * first `image`/`buffer`/`base64` key (base64 string or numeric byte array).
 * Returns null if none found.
 */
export function extractDownloadBuffer(json: unknown): Buffer | null {
  const seen = new Set<object>();
  const walk = (node: unknown): Buffer | null => {
    if (node === null || typeof node !== "object") return null;
    if (seen.has(node as object)) return null;
    seen.add(node as object);
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if ((key === "image" || key === "buffer" || key === "base64") && typeof v === "string" && v.length > 32 && /^[A-Za-z0-9+/=\r\n]+$/.test(v)) {
        return Buffer.from(v.replace(/\s+/g, ""), "base64");
      }
      if (key === "buffer" && Array.isArray(v) && v.length > 0) {
        return Buffer.from((v as unknown[]).map((x) => Number(x) & 0xff));
      }
    }
    for (const v of Object.values(node as Record<string, unknown>)) {
      const r = walk(v);
      if (r) return r;
    }
    return null;
  };
  return walk(json);
}

// ──────────────────────────────────────────────
// Client
// ──────────────────────────────────────────────

type MessageHandler = (msg: NormalizedMessage) => void;

export class WcppClient {
  public wxid: string | null;
  private baseUrl: string;

  // Sync cursor (used by forceSync WS frames and by the login verify call)
  private synckey: string; // base64 KeyBuf.buffer for next request
  private seenMsgIds: Set<string> = new Set();
  private readonly SEEN_MSG_ID_MAX = 10000;

  // Webhook state
  private webhookServer: HttpServer | null = null;

  // Contact cache (from Sync responses)
  private contactCache: Map<string, SyncContact> = new Map();

  // Common
  private _onMessage: MessageHandler | null = null;
  private config: WcppConfig;

  // Randomized CDN image-download retry policy + its [0,1) generator.
  private imageRetry: ImageRetryConfig;
  private imageRng: () => number;

  // Outbound proxy transport (direct unless `proxy` is configured)
  private proxyTransport: ProxyTransport;

  constructor(
    config: WcppConfig,
    private log: Logger,
  ) {
    this.config = config;
    this.imageRetry = config.imageRetry ?? DEFAULT_IMAGE_RETRY;
    this.imageRng = makeRng(this.imageRetry.randomSeed);
    this.wxid = config.wxid ?? null;
    this.baseUrl = config.host ? `http://${config.host}:${config.port}` : "";
    this.synckey = ""; // empty until we ingest a real KeyBuf cursor; doSyncRequest omits Synckey while empty
    // Throws on an unsupported proxy scheme — fail fast at startup with a clear message.
    this.proxyTransport = buildProxyTransport(config.proxy);
    this.log.info(
      this.proxyTransport.kind === "direct"
        ? "[net] outbound = direct (no proxy; bypasses any ambient env proxy)"
        : `[net] outbound via ${this.proxyTransport.kind} proxy`,
    );
  }

  /**
   * fetch() that always carries our proxy dispatcher. For the direct case the
   * dispatcher is a plain undici Agent, which is what overrides OpenClaw's
   * process-global EnvHttpProxyAgent — a bare fetch() would inherit it.
   */
  private httpFetch(
    input: string,
    init: Parameters<typeof undiciFetch>[1] = {},
  ): ReturnType<typeof undiciFetch> {
    return undiciFetch(input, { ...init, dispatcher: this.proxyTransport.dispatcher });
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
   * server — /Webhook/Set is the operator's job. The real-time push longlink
   * is established automatically at login (do NOT call /Login/Newinit — it is
   * full re-init and ban-risky; see CLAUDE.md). Return a synthetic credentials
   * object so the gateway treats the channel as up.
   *
   * Active mode (host set): never call /Login/Newinit (full-init, ban-risky —
   * see CLAUDE.md "Scope & Responsibilities"); the push longlink already comes
   * up at login. Just verify the authcode via a single /api/Msg/Sync probe.
   */
  async login(): Promise<WcppCredentials | null> {
    if (!this.config.host) {
      this.log.info("[probe] passive webhook-only mode (no host); skipping server verification");
      return { authcode: this.config.authcode ?? "", wxid: this.wxid ?? "unknown" };
    }

    if (!this.config.authcode) {
      this.log.error("[probe] authcode is required when host is set");
      return null;
    }

    const testResult = await this.doSyncRequest();
    if (!testResult || !testResult.Success) {
      this.log.error("[probe] sync probe failed, authcode may be invalid");
      return null;
    }

    // KeyBuf is the sync cursor — must be picked up from ANY successful Sync,
    // not gated on ModUserInfos. Without this, synckey stays as the "string"
    // placeholder forever and forceSync sends a meaningless WS frame.
    if (testResult.Data?.KeyBuf?.buffer) {
      this.synckey = testResult.Data.KeyBuf.buffer;
    }

    if (testResult.Data?.ModUserInfos?.[0]) {
      this.wxid = testResult.Data.ModUserInfos[0].UserName.string;
      this.log.info(`[probe] sync probe OK, wxid=${this.wxid}`);
      this.ingestContacts(testResult);
      return { authcode: this.config.authcode, wxid: this.wxid! };
    }

    this.log.info("[probe] sync probe OK but no ModUserInfos");
    return { authcode: this.config.authcode, wxid: this.wxid ?? "unknown" };
  }

  // ──────────────────────────────────────────────
  // Sync polling (WCPP MAX)
  // ──────────────────────────────────────────────

  private async doSyncRequest(): Promise<SyncResponse | null> {
    const authcode = this.config.authcode;
    if (!authcode) return null;

    const url = `${this.baseUrl}/api/Msg/Sync?authcode=${authcode}`;
    // WCPPM Swagger spec: body is `{ "Scene": 0 }` with Synckey omitted on
    // first call. Sending Synckey="" or a placeholder string returns no data.
    // Only attach Synckey once we've ingested a real KeyBuf cursor.
    const payload: { Scene: number; Synckey?: string } = { Scene: 0 };
    if (this.synckey) payload.Synckey = this.synckey;

    try {
      const res = await this.httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        this.log.error(`[sync] HTTP ${res.status}`);
        return null;
      }
      return (await res.json()) as SyncResponse;
    } catch (e) {
      this.log.error("[sync] request error", e);
      return null;
    }
  }

  /**
   * Process a Sync response: update synckey, cache contacts, emit messages.
   */
  private processSyncResponse(resp: SyncResponse): void {
    if (!resp.Data) return;
    this.ingestSyncMessages(resp);
  }

  /**
   * Shared inbound ingest pipeline used by both the HTTP Sync path
   * (processSyncResponse / forceSync / webhook) and the WebSocket push
   * handler (after it unwraps the 20260411+ envelope to the inner
   * SyncResponse). Holds: synckey update from KeyBuf, contact caching,
   * self-wxid detection from ModUserInfos, then the per-message
   * MsgType filter, dedup, normalize, drop-own-DM, and emit. (No CreateTime
   * age filter — every message is surfaced so the downstream pipeline can
   * persist it; broadcast recency is gated later in ingest.ts.)
   *
   * Own-message policy: drop own DMs (`senderWxid === this.wxid && !isGroup`)
   * but KEEP own group messages — unified across all transports here so the
   * WS path no longer diverges from the Sync/webhook path.
   */
  private ingestSyncMessages(inner: SyncResponse): void {
    if (!inner.Data) return;

    // Update synckey for the next poll / so forceSync can echo a real cursor
    if (inner.Data.KeyBuf?.buffer) {
      this.synckey = inner.Data.KeyBuf.buffer;
    }

    // Cache contacts
    this.ingestContacts(inner);

    // Extract self wxid from ModUserInfos if not set
    if (!this.wxid && inner.Data.ModUserInfos?.[0]) {
      this.wxid = inner.Data.ModUserInfos[0].UserName.string;
      this.log.info(`[sync] detected wxid=${this.wxid}`);
    }

    // Process messages
    const allowTypes = this.config.allowMsgTypes ?? [1, 3, 34, 47, 48, 49];
    const passRevoke = this.config.passRevokemsg ?? true;

    for (const msg of inner.Data.AddMsgs ?? []) {
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

      // Suppress the transient "file uploading…" placeholder (appmsg type 74):
      // it carries no <attachid> (not downloadable) and the real, downloadable
      // file (type 6) follows within seconds. Dropping it here — like the type-51
      // status filter above — keeps OpenClaw from seeing a useless duplicate
      // attachment. (Type-filter drop, NOT an age drop, so the store-all rule
      // for real messages is untouched.)
      if (msg.MsgType === 49 && this.extractXmlTag(msg.Content?.string ?? "", "type") === "74") {
        continue;
      }

      // NOTE: no CreateTime age filter here. The middleware persists every
      // new (by stable-id dedup) message to SQLite regardless of age — so a
      // backlog redelivery / brief downtime gap is captured losslessly. Whether
      // an old message is *dispatched* to the agent is decided downstream in
      // ingest.ts (maxBroadcastAge), so we never replay stale history as live
      // auto-replies. See db.ts/ingest.ts for the durable dedup.

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
        // Drop own DMs; keep own group messages (unless from filehelper or similar)
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
    let inner = match?.[1]?.trim();
    if (!inner) return null;
    // Unwrap a CDATA section if the whole value is one (e.g. <url><![CDATA[…]]></url>).
    const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    if (cdata) inner = cdata[1].trim();
    return inner || null;
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
      const appType = this.extractXmlTag(content, "type");
      if (appType === "6" || appType === "74") return title ? `[文件] ${title}` : "[文件]";
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
      // Image XML carries these as <img> ATTRIBUTES (aeskey="…" cdnbigimgurl="…"),
      // not child elements — match the attribute form (plus element/CDATA forms
      // for safety across message variants).
      aesKey: pick(/<aeskey><!\[CDATA\[(.*?)\]\]><\/aeskey>/i, /<aeskey>([^<]+)<\/aeskey>/i, /aeskey="([^"]+)"/i),
      cdnMidImgUrl: pick(/<cdnmidimgurl><!\[CDATA\[(.*?)\]\]><\/cdnmidimgurl>/i, /<cdnmidimgurl>([^<]+)<\/cdnmidimgurl>/i, /cdnmidimgurl="([^"]+)"/i),
      cdnBigImgUrl: pick(/<cdnbigimgurl><!\[CDATA\[(.*?)\]\]><\/cdnbigimgurl>/i, /<cdnbigimgurl>([^<]+)<\/cdnbigimgurl>/i, /cdnbigimgurl="([^"]+)"/i),
      cdnThumbUrl: pick(/<cdnthumburl><!\[CDATA\[(.*?)\]\]><\/cdnthumburl>/i, /<cdnthumburl>([^<]+)<\/cdnthumburl>/i, /cdnthumburl="([^"]+)"/i),
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

  /**
   * Parse an inbound file attachment (MsgType 49, appmsg `<type>6</type>`).
   * Returns null for anything else — crucially for the `<type>74</type>`
   * "uploading…" placeholder (no `<attachid>`, hence not downloadable) and for
   * quote(57)/link(5) appmsgs.
   */
  extractFileMessageInfo(message: SyncMessage | NormalizedMessage): FileMessageInfo | null {
    const msgType = "msgType" in message ? message.msgType : message.MsgType;
    if (msgType !== 49) return null;

    const rawXml = "content" in message ? message.content : message.Content?.string ?? "";
    if (this.extractXmlTag(rawXml, "type") !== "6") return null;

    const attachId = this.extractXmlTag(rawXml, "attachid");
    if (!attachId) return null; // placeholder / not yet downloadable

    const fromUserName = "fromUser" in message
      ? message.fromUser
      : message.FromUserName?.string ?? null;
    const msgId = "msgId" in message ? Number(message.msgId) : message.MsgId ?? null;
    const totalLenRaw = this.extractXmlTag(rawXml, "totallen");

    return {
      msgId: Number.isFinite(msgId) ? (msgId as number) : null,
      fromUserName,
      appId: this.extractXmlAttr(rawXml, "appmsg", "appid"),
      attachId,
      cdnAttachUrl: this.extractXmlTag(rawXml, "cdnattachurl"),
      aesKey: this.extractXmlTag(rawXml, "aeskey"),
      totalLen: totalLenRaw ? Number(totalLenRaw) : null,
      fileExt: this.extractXmlTag(rawXml, "fileext"),
      title: this.extractXmlTag(rawXml, "title"),
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
      // Quote/reply: <title> is the user's actual reply text — return it as-is.
      // The quoted context is attached separately via NormalizedMessage.quote.
      if (appType === "57") return title ?? "";
      if (appType === "5") return this.formatLinkCard(content);
      // File attachment: type 6 = completed (downloadable), 74 = uploading
      // placeholder. Both display as a file so a download miss still reads right.
      if (appType === "6" || appType === "74") return title ? `[文件] ${title}` : "[文件]";
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
   * Format an inbound link/article share card (MsgType 49, appType 5) into a
   * richer multi-line display string, so the downstream agent sees the source
   * app, title, description and URL — not just the old flat `[链接] 标题`.
   *
   *   [小红书] 被人捏胸
   *   #健身  #要做一个有胸肌的男人  #肌肉的重要性  #真拿你没办法
   *   🔗 https://www.xiaohongshu.com/discovery/item/6a37?…
   *
   * Missing fields are simply omitted: a card with only a title collapses to a
   * single `[链接] 标题` line, matching the previous behaviour.
   */
  formatLinkCard(content: string): string {
    const title = this.extractXmlTag(content, "title");
    const des = this.extractXmlTag(content, "des");
    const rawUrl = this.extractXmlTag(content, "url");
    const url = rawUrl ? this.unescapeXmlEntities(rawUrl) : null;
    // Source app: <appinfo><appname>…</appname>, or the legacy <sourcedisplayname>.
    const source =
      this.extractXmlTag(content, "appname") ||
      this.extractXmlTag(content, "sourcedisplayname") ||
      "链接";

    const headline = title || url;
    const lines = [headline ? `[${source}] ${headline}` : `[${source}]`];
    if (des) lines.push(des);
    // Only append the URL line when it isn't already the headline (title-less card).
    if (url && url !== headline) lines.push(`🔗 ${url}`);
    return lines.join("\n");
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
   * Operator-triggered manual catch-up. **Exactly one** HTTP POST
   * /api/Msg/Sync. Whatever it returns flows through the normal dedup +
   * filter + dispatch pipeline.
   *
   * Independent of the real-time push path: WCPPM establishes the push
   * longlink automatically at login (NOT via /Login/Newinit, which is
   * full-init and ban-risky — see CLAUDE.md). /api/Msg/Sync is a separate
   * on-demand pull that works whether the longlink is up or not.
   *
   * **No loop.** If `hasMore` (Sync's `ContinueFlag != 0`), the operator
   * decides whether to invoke forceSync again — not the code. Auto-looping
   * was the Account-Safety-Incident pattern (~260 requests on one trigger).
   *
   * (We also tried sending a Sync request frame over the open /ws/sync WS;
   * WCPPM logged receipt but never pushed anything back, so /ws/sync is
   * push-only from WCPPM's side and can't be used as a pull trigger.)
   */
  async forceSync(): Promise<{ ok: boolean; reason?: string; messages?: number; hasMore?: boolean }> {
    const before = this.seenMsgIds.size;
    const resp = await this.doSyncRequest();
    if (!resp) return { ok: false, reason: "Sync request failed (see logs)" };
    if (!resp.Success) {
      return { ok: false, reason: `WCPPM Sync !Success Code=${resp.Code} Message=${resp.Message}` };
    }
    if (resp.Data) this.processSyncResponse(resp);
    const messages = this.seenMsgIds.size - before;
    // hasMore must reflect "more backlog to drain", not a raw flag bit. The
    // "当前未有新消息" empty response carries CmdList:{Count:0} (no AddMsgs) yet a
    // non-zero ContinueFlag (e.g. 256) — a status bitmask, not a continuation.
    // Only claim more when this round actually delivered a batch.
    const batchSize = resp.Data?.AddMsgs?.length ?? 0;
    const hasMore = batchSize > 0 && (resp.Data?.ContinueFlag ?? 0) !== 0;
    this.log.info(`[sync] forceSync drained one round, ${messages} new message(s), hasMore=${hasMore}`);
    return { ok: true, messages, hasMore };
  }

  // ──────────────────────────────────────────────
  // WebSocket (WCPPM push — base inbound transport)
  // ──────────────────────────────────────────────

  private maxWs: WebSocket | null = null;
  private maxWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWsPingTimer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive reconnect attempts; drives exponential backoff. Reset to 0 on 'open'. */
  private maxWsReconnectAttempt = 0;

  connectMaxWebSocket(): void {
    const authcode = this.config.authcode;
    if (!authcode) {
      this.log.error("[ws] cannot connect without authcode");
      return;
    }

    // Clear any stale keepalive interval from a previous socket so we never
    // leave a second interval pinging the new connection (interval leak).
    if (this.maxWsPingTimer) {
      clearInterval(this.maxWsPingTimer);
      this.maxWsPingTimer = null;
    }

    // Use custom wsUrl if provided, otherwise construct from host
    const wsUrl = this.config.wsUrl ?? `ws://${this.config.host}:8089/ws/sync?authcode=${authcode}`;
    this.log.info(`[ws] connecting to ${wsUrl.replace(/authcode=[^&]+/, "authcode=***")}`);

    this.maxWs = this.proxyTransport.wsAgent
      ? new WebSocket(wsUrl, { agent: this.proxyTransport.wsAgent })
      : new WebSocket(wsUrl);

    this.maxWs.on("open", () => {
      this.log.info("[ws] connected");
      // Healthy connection — reset backoff so the next drop reconnects fast.
      this.maxWsReconnectAttempt = 0;
    });

    this.maxWs.on("message", (raw: WebSocket.Data) => this.handleWsMessage(raw.toString()));

    this.maxWs.on("close", (code) => {
      this.log.warn(`[ws] closed (code=${code})`);
      // Stop pinging the dead socket; connectMaxWebSocket will start a fresh
      // interval on the next connection.
      if (this.maxWsPingTimer) {
        clearInterval(this.maxWsPingTimer);
        this.maxWsPingTimer = null;
      }
      this.scheduleMaxWsReconnect();
    });

    this.maxWs.on("error", (err) => this.log.error("[ws] error", err));

    // Keepalive — single interval owned by this.maxWsPingTimer (cleared at the
    // top of connectMaxWebSocket, in 'close', and in disconnectMaxWebSocket) so
    // a reconnect never leaves a stale interval pinging the new socket.
    this.maxWsPingTimer = setInterval(() => {
      if (this.maxWs?.readyState === WebSocket.OPEN) {
        this.maxWs.ping();
      } else if (this.maxWsPingTimer) {
        clearInterval(this.maxWsPingTimer);
        this.maxWsPingTimer = null;
      }
    }, 30_000);
  }

  /**
   * Parse + ingest a single WCPPM WS push frame. Extracted from the socket
   * 'message' handler so it can be unit-tested against real captured frames.
   */
  handleWsMessage(raw: string): void {
    // Trace: the COMPLETE raw push frame, verbatim. At debug this is the single
    // most useful line for diagnosing inbound issues (empty image bodies, new
    // MsgTypes, envelope-shape drift) — never guess at the wire, read it.
    this.log.debug(`[ws] raw ${raw}`);
    try {
      const envelope = JSON.parse(raw) as MaxWsEnvelope;
      if (!envelope.Success || !envelope.Data) return;

      // Unwrap. The 0416 server nests the SyncResponse *Data* payload directly
      // under Data.syncData (AddMsgs/ModContacts/… at its top level, no inner
      // .Success/.Data). A legacy shape wrapped a full SyncResponse under
      // Data.data — normalize both to a SyncResponse.Data payload.
      const wrapped = envelope.Data.syncData ?? envelope.Data.data;
      if (!wrapped || typeof wrapped !== "object") {
        this.log.debug("[ws] envelope has no recognizable inner SyncResponse");
        return;
      }
      const payload: SyncResponse["Data"] =
        "AddMsgs" in wrapped ? wrapped : (wrapped as SyncResponse).Data;
      if (!payload) {
        this.log.debug("[ws] envelope has no recognizable inner SyncResponse");
        return;
      }

      // Extract wxid from envelope-level field (available in syncData variant).
      // The inner-SyncResponse path (ModUserInfos) is handled inside
      // ingestSyncMessages; this envelope field is WS-specific.
      if (!this.wxid && envelope.Data.wxid) {
        this.wxid = envelope.Data.wxid;
        this.log.info(`[ws] detected wxid=${this.wxid} from envelope`);
      }

      // Hand the normalized SyncResponse to the shared ingest pipeline
      // (synckey update, contacts, wxid-from-ModUserInfos, filters, dedup,
      // normalize, drop-own-DM, emit) — same path as Sync/webhook.
      this.ingestSyncMessages({
        Code: envelope.Code ?? 0,
        Success: true,
        Message: envelope.Message ?? "ws",
        Data: payload,
      });
    } catch (e) {
      this.log.debug("[ws] message parse error", e);
    }
  }

  private scheduleMaxWsReconnect(): void {
    if (this.maxWsReconnectTimer) return;
    // Exponential backoff with a cap + jitter — a tight fixed-interval
    // reconnect loop is exactly the suspicious connect/disconnect pattern
    // CLAUDE.md's account-safety rules warn against.
    const base = Math.min(5000 * 2 ** this.maxWsReconnectAttempt, 60_000);
    const jitter = base * (Math.random() * 0.4 - 0.2); // ±20%
    const delay = Math.max(0, Math.round(base + jitter));
    this.maxWsReconnectAttempt += 1;
    this.log.warn(`[ws] reconnecting in ${delay}ms (attempt ${this.maxWsReconnectAttempt})`);
    this.maxWsReconnectTimer = setTimeout(() => {
      this.maxWsReconnectTimer = null;
      this.connectMaxWebSocket();
    }, delay);
  }

  disconnectMaxWebSocket(): void {
    if (this.maxWsReconnectTimer) {
      clearTimeout(this.maxWsReconnectTimer);
      this.maxWsReconnectTimer = null;
    }
    if (this.maxWsPingTimer) {
      clearInterval(this.maxWsPingTimer);
      this.maxWsPingTimer = null;
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
    // Idempotent: connect() already owns webhook bring-up, so a second call here
    // (e.g. from a bootstrap that also calls connect()) must NOT listen() the
    // port again — that double-bind throws EADDRINUSE and crashes the process.
    if (this.webhookServer) {
      this.log.warn("[webhook] server already running; ignoring duplicate startWebhookServer()");
      return;
    }
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
      let bodyBytes = 0;
      let bodyTooLarge = false;
      const MAX_BODY_BYTES = 5 * 1024 * 1024;
      req.on("data", (chunk: Buffer) => {
        if (bodyTooLarge) return;
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
          bodyTooLarge = true;
          this.log.warn(`[webhook] body exceeded ${MAX_BODY_BYTES} bytes, rejecting (413)`);
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "payload too large" }));
          req.destroy();
          return;
        }
        body += chunk.toString();
      });
      req.on("end", () => {
        if (bodyTooLarge) return;
        // Trace: the COMPLETE raw webhook body, verbatim (see the [ws] raw note).
        this.log.debug(`[webhook] raw ${body}`);
        try {
          const envelope = JSON.parse(body) as WebhookEnvelope;

          // Signature verification
          if (this.config.webhookSecret) {
            const verdict = verifyWebhookSignature(envelope, this.config.webhookSecret);
            if (!verdict.ok) {
              // Silent-drop escape hatch: empty signature field means the
              // push was enqueued before a secret was configured on WCPPM.
              // Accept + drop so WCPPM removes it from the retry queue, but
              // do NOT run it through the agent pipeline.
              if (verdict.gotLen === 0 && this.config.webhookSilentDropUnsigned === true) {
                const n = envelope.Data?.messages?.length ?? 0;
                this.log.warn(
                  `[webhook] silently dropping unsigned push ` +
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
                  `[webhook] signature verification failed — ` +
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
                this.log.warn("[webhook] signature verification failed (enable webhookDebug for details)");
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

          // Timestamp anti-replay check (15 minute window). In 0416 the webhook
          // is an empty doorbell, so a stale one carries no message and is just
          // a backlog redelivery being flushed — benign. Drop it (200 so WCPPM
          // drains its retry queue), but log at debug, not warn: it needs no
          // attention. Real messages flow over the WS push and are persisted
          // there regardless of age (see ingestSyncMessages).
          if (Math.abs(Date.now() / 1000 - envelope.Timestamp) > 900) {
            const ageSec = Math.round(Date.now() / 1000 - envelope.Timestamp);
            this.log.debug(`[webhook] dropping stale doorbell (ts=${envelope.Timestamp}, age=${ageSec}s)`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, warning: "timestamp skew" }));
            return;
          }

          // Learn wxid from envelope
          if (!this.wxid && envelope.Wxid) {
            this.wxid = envelope.Wxid;
            this.log.info(`[webhook] detected wxid=${this.wxid}`);
          }

          // Process messages through the standard pipeline
          this.processWebhookMessages(envelope);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          this.log.debug("[webhook] parse error", e);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
        }
      });
    });

    this.webhookServer.listen(port, host, () => {
      this.log.info(`[webhook] server listening on ${host}:${port}${basePath}`);
    });
  }

  stopWebhookServer(): void {
    if (this.webhookServer) {
      this.webhookServer.close();
      this.webhookServer = null;
      this.log.info("[webhook] server stopped");
    }
  }

  /**
   * Shared-webhook-listener entrypoint: the listener has already parsed and
   * signature-verified the envelope and routed it here by `Wxid`. Learn the
   * self-wxid if not yet known, then run the inline messages through the same
   * pipeline as WS push — so cross-transport duplicates (WS push then webhook
   * a few seconds later) are deduped by the shared `seenMsgIds` set.
   */
  ingestWebhookEnvelope(envelope: WebhookEnvelope): void {
    if (!this.wxid && envelope.Wxid) {
      this.wxid = envelope.Wxid;
      this.log.info(`[webhook] detected wxid=${this.wxid}`);
    }
    this.processWebhookMessages(envelope);
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
      this.log.error("[webhook] webhookUrl is required to register");
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
      const res = await this.httpFetch(`${this.baseUrl}/api/Webhook/Set?authcode=${authcode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;
      if (data.Success) {
        this.log.info(`[webhook] registered → ${url}`);
        return true;
      }
      this.log.error(`[webhook] failed to register: ${data.Message}`);
      return false;
    } catch (e) {
      this.log.error("[webhook] error registering", e);
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
      await this.httpFetch(`${this.baseUrl}/api/Webhook/Remove?authcode=${authcode}`, { method: "POST" });
      this.log.info("[webhook] removed");
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
        this.log.info("[webhook] webhookEnabled but no webhookUrl set; skipping /Webhook/Set (operator-managed)");
      } else {
        this.log.info("[webhook] passive webhook-only mode; /Webhook/Set is operator-managed (the push longlink comes up automatically at login — do NOT call /Login/Newinit)");
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
      this.log.warn("[send] read-only mode active, not sending message");
      return false;
    }

    const url = `${this.baseUrl}/api/Msg/SendTxt?${this.authQuery()}`;
    try {
      const res = await this.httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ToWxid: to, Content: text, Type: 1 }),
      });
      const data = (await res.json()) as any;
      if (data.Code === 0 || data.Code === 200) return true;
      this.log.warn("[send] SendTxt returned non-success", data);
      return false;
    } catch (e) {
      this.log.error("[send] error sending text", e);
      return false;
    }
  }

  async sendImage(to: string, base64Data: string): Promise<boolean> {
    if (this.config.readOnly) {
      this.log.warn("[send] read-only mode active, not sending image");
      return false;
    }

    // Confirmed path: /api/Msg/UploadImg (发送图片), payload { Base64, ToWxid }
    // — see docs/api-reference/api/356821074e0.md. The old
    // /message/SendImageNewMessage path + MsgItem/ImageContent shape do not
    // exist in the MAX API and 404'd silently.
    const url = `${this.baseUrl}/api/Msg/UploadImg?${this.authQuery()}`;

    try {
      const res = await this.httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Base64: base64Data, ToWxid: to }),
      });
      const data = (await res.json()) as any;
      return data.Code === 0 || data.Code === 200;
    } catch (e) {
      this.log.error("[send] error sending image", e);
      return false;
    }
  }

  private buildAttachmentCandidate(
    kind: "voice" | "image" | "video" | "file",
    msgId: string,
    fileOpts?: { fileExt?: string | null; title?: string | null },
  ): AttachmentCandidate {
    if (kind === "file") {
      const ext = (fileOpts?.fileExt ?? "bin").toLowerCase();
      return {
        kind,
        mimeType: fileExtToMime(fileOpts?.fileExt),
        extension: `.${ext}`,
        fileName: safeFileName(fileOpts?.title, msgId, fileOpts?.fileExt),
        msgId,
      };
    }
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

    // Guard against false success: if the endpoint returned 200 but no bytes
    // (e.g. a WeChat-level ret error with an empty buffer), the file was never
    // written — surface it instead of handing back a path to a missing file.
    if (!result.outputPath && !result.buffer) {
      throw new Error("WCPP: media download returned no bytes (server error or empty response)");
    }

    return {
      filePath,
      // The bytes may arrive base64-wrapped in a JSON envelope (e.g.
      // CdnDownloadImage), so the HTTP content-type is application/json — not the
      // media type. Prefer it only when it's a real media content-type.
      mimeType:
        result.contentType && !result.contentType.includes("application/json")
          ? result.contentType
          : attachment.mimeType,
      fileName: attachment.fileName,
    };
  }

  private async downloadMediaEndpoint(
    endpoint: string,
    payload: Record<string, unknown>,
    outputPath?: string,
  ): Promise<MediaDownloadResult> {
    // All MAX endpoints live under /api (the swagger basePath); the Tools paths
    // are passed in WITHOUT it (e.g. "/Tools/DownloadImg") — prefix it here.
    // Omitting /api is a route miss → "404 nomatch".
    const url = `${this.baseUrl}/api${endpoint}?${this.authQuery()}`;

    const res = await this.httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*" },
      body: JSON.stringify(payload),
    });

    const contentType = res.headers.get("content-type");
    if (!res.ok) {
      // Surface the server's body — it carries the actual reason (route miss,
      // bad param, …) and is otherwise swallowed by the lazy-fetch catch.
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      throw new Error(`WCPP: /api${endpoint} HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }

    let buffer: Buffer | null = null;
    let responseJson: unknown;

    if (contentType?.includes("application/json")) {
      const data = (await res.json()) as unknown;
      responseJson = data;
      buffer = extractDownloadBuffer(data);
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
    // Received images are CDN-hosted (the XML carries aeskey + cdn*imgurl), so
    // download via `/api/Tools/CdnDownloadImage` ({ fileAesKey, fileNo }) — the
    // cache-based `/Tools/DownloadImg` returns ret=-104 "cacheSize do not equal
    // totalLen" because the server has nothing cached for the message. fileNo is
    // the CDN file id (the cdn*imgurl value); bytes come back base64 at Data.Image.
    const fileNo = info.cdnBigImgUrl ?? info.cdnMidImgUrl ?? info.cdnThumbUrl;
    if (!info.aesKey || !fileNo) {
      throw new Error("WCPP: image message is missing CDN download fields (aeskey/cdn url)");
    }

    const payload = { fileAesKey: info.aesKey, fileNo };

    // The CDN object isn't always ready the instant the push arrives: a fetch in
    // the same second returns 200 with an empty Data.Image, while a retry a beat
    // later succeeds (confirmed live). Retry with a jittered backoff until bytes
    // appear. Total attempts + each delay are randomized (see ImageRetryConfig):
    // a fixed randomSeed reproduces the sequence, otherwise it's unpredictable.
    const { minAttempts, maxAttempts, baseDelayMs, jitterPct } = this.imageRetry;
    const maxTries = minAttempts + Math.floor(this.imageRng() * (maxAttempts - minAttempts + 1));
    let result = await this.downloadMediaEndpoint("/Tools/CdnDownloadImage", payload, outputPath);
    for (let attempt = 1; attempt < maxTries && !(result.buffer && result.buffer.length > 0); attempt++) {
      const delay = Math.max(0, Math.round(baseDelayMs * (1 + (this.imageRng() * 2 - 1) * jitterPct)));
      this.log.debug(`[media] CdnDownloadImage returned no bytes (attempt ${attempt}/${maxTries}); retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      result = await this.downloadMediaEndpoint("/Tools/CdnDownloadImage", payload, outputPath);
    }
    return result;
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

  /**
   * Download a file attachment via `/Tools/DownloadFile`. Tries a single-shot
   * (sectionLen = the whole file); if the server caps the section size and
   * returns a partial buffer, falls back to a bounded section loop that
   * concatenates chunks until `totalLen` bytes are collected.
   */
  async downloadFile(message: SyncMessage | NormalizedMessage, outputPath?: string): Promise<MediaDownloadResult> {
    const info = this.extractFileMessageInfo(message);
    if (!info) {
      throw new Error("WCPP: message is not a downloadable file message (MsgType 49 appType 6)");
    }
    if (!info.attachId || !info.fromUserName || info.totalLen == null) {
      throw new Error("WCPP: file message is missing required download fields (attachid/fromUserName/totallen)");
    }

    const total = info.totalLen;
    const MAX_SECTION = 64 * 1024; // conservative per-chunk cap for the loop fallback
    const fetchSection = (start: number, len: number) =>
      this.downloadMediaEndpoint("/Tools/DownloadFile", {
        appID: info.appId ?? "",
        attachId: info.attachId,
        userName: info.fromUserName,
        dataLen: total,
        sectionStart: start,
        sectionLen: len,
      });

    const first = await fetchSection(0, total);
    let buffer = first.buffer ?? Buffer.alloc(0);

    // Section-loop fallback only if the first shot came back short.
    let guard = 0;
    while (buffer.length > 0 && buffer.length < total && guard++ < 1024) {
      const next = await fetchSection(buffer.length, Math.min(MAX_SECTION, total - buffer.length));
      if (!next.buffer || next.buffer.length === 0) break; // server gave nothing more
      buffer = Buffer.concat([buffer, next.buffer]);
    }

    const result: MediaDownloadResult = {
      contentType: first.contentType,
      buffer: buffer.length > 0 ? buffer : null,
      responseJson: first.responseJson,
      requestPayload: { appID: info.appId ?? "", attachId: info.attachId, dataLen: total },
    };

    if (outputPath && buffer.length > 0) {
      const fs = await import("fs/promises");
      await fs.writeFile(outputPath, buffer);
      result.outputPath = outputPath;
    }
    return result;
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

    const file = this.extractFileMessageInfo(message);
    if (file) {
      const attachment = this.buildAttachmentCandidate("file", String(file.msgId ?? "unknown"), {
        fileExt: file.fileExt,
        title: file.title,
      });
      return {
        kind: "file",
        info: file,
        attachment,
        download: (outputPath?: string) => this.downloadFile(message, outputPath),
        materialize: (dir?: string) => this.materializeMedia((outputPath?: string) => this.downloadFile(message, outputPath), attachment, dir),
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
      this.log.warn("[send] read-only mode active, not sending quote");
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
      const res = await this.httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;
      if (data.Code === 0 || data.Code === 200) return true;
      this.log.warn("[send] Quote API returned non-success", data);
      return false;
    } catch (e) {
      this.log.error("[send] error sending quote", e);
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
      const res = await this.httpFetch(`${this.baseUrl}/api/Group/GetChatRoomMemberDetail?${this.authQuery()}`, {
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
      // Confirmed path: /api/Friend/GetContractList (upstream spells it
      // "Contract", not "Contact") — see docs/api-reference/api/356820974e0.md.
      // TODO(verify body): the doc schema uses lowercase
      // currentChatRoomContactSeq / currentWxcontactSeq; we still send the
      // PascalCase variants below. Leaving the body as-is to keep this change
      // path-only; confirm field casing against a live MAX response.
      const res = await this.httpFetch(`${this.baseUrl}/api/Friend/GetContractList?${this.authQuery()}`, {
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
