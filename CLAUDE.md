# CLAUDE.md — LLM Guide for wcppm-lob

## What This Is

An OpenClaw channel plugin that bridges WeChatPadPro / WeChatPadProMAX into OpenClaw, enabling WeChat message send/receive through the OpenClaw framework.

## Scope & Responsibilities

**This plugin does NOT handle:**
- **Login/Authentication** — QR code scanning, 62-data login, A16 login, token renewal, heartbeat management, and all `/Login/*` operations are handled externally by the WeChatPadProMax server administrator
- **Account lifecycle** — initialization (`Newinit`), auto-heartbeat, reconnection, etc.

**This plugin assumes:**
- The WeChatPadProMax server is already logged in and online
- A valid `authcode` (for MAX) or `adminKey` + `authKey` (for standard WCPP) is provided by the server admin
- The WeChat account is stable and ready to send/receive messages

**This plugin focuses on:**
- Message synchronization (receiving via WebSocket or HTTP Sync polling)
- Message sending (text, image, voice, etc.)
- Contact/group metadata caching
- OpenClaw channel protocol compliance

## Architecture

```
src/
├── index.ts          — Plugin entry point (defineChannelPluginEntry)
├── channel.ts        — OpenClaw channel plugin definition + runtime lifecycle
├── client.ts         — Core API client: auth, WebSocket, Sync polling, send
├── setup-entry.ts    — Lightweight setup entry for onboarding
└── shims/
    └── openclaw/
        └── channel-core.ts  — Type shims for standalone compilation
```

## Two Sync Modes

### WS Mode (standard WeChatPadPro)
- WebSocket at `ws://host:port/ws/GetSyncMsg?key=AUTHKEY`
- Requires `adminKey` to generate an auth key
- Real-time push, auto-reconnect

### Sync Mode (WeChatPadProMAX — HTTP polling)
- HTTP POST to `/api/Msg/Sync?authcode=AUTHCODE`
- Uses incremental polling with `Synckey` (protobuf base64 from `Data.KeyBuf.buffer`)
- `ContinueFlag != 0` → more data available, poll again immediately
- Otherwise wait `syncInterval` ms (default 5000) before next poll
- Automatically activated when `authcode` is set and `syncMode` is `"sync"`

### WebSocket Mode (WeChatPadProMAX — push)
- WebSocket at `ws://host:8089/ws/sync?authcode=AUTHCODE`
- Real-time push of SyncResponse messages (same format as HTTP Sync)
- Uses same message processing pipeline as Sync mode
- Auto-reconnect on disconnect
- Set `syncMode: "websocket"` and optionally `wsUrl` for custom URL
- If `wsUrl` is not set, auto-constructs from `host` as `ws://{host}:8089/ws/sync?authcode={authcode}`

## WeChat Message Format

### Group Messages
`Content.string` = `sender_wxid:\nactual message text`
Must split on first `:\n` to extract sender and text.

### Private Messages
`Content.string` = raw text (no prefix)

### MsgType Reference
| MsgType | Meaning | Action |
|---------|---------|--------|
| 1 | Text | Pass through |
| 3 | Image (XML with CDN URL) | Pass through |
| 34 | Voice (XML with voiceurl) | Pass through |
| 47 | Sticker/emoji (XML with CDN URL) | Pass through |
| 49 | App/XML message (sub-types via `<type>` tag) | Parse `<title>`, pass through |
| 51 | Internal status sync (`<op id=2/5/7/9/11>`) | **Always drop** |
| 10002 | System message (dynacfg, revokemsg, etc.) | Drop except `revokemsg` |

### MsgType 49 Sub-types (check XML `<type>`)
- `57` = Quote/reply message
- `5` = Link card (URL in `<url>`)
- `3` = Image (sometimes uses MsgType 3 instead)

### MsgType 51 Op IDs (all noise, always filter)
- `2`/`5` = lastMessage read status sync
- `9` = Moments timeline update
- `7` = Moments unread status
- `11` = HandOff device switch

### MsgType 10002 Sub-types
- `dynacfg` = Dynamic config push (huge key-value blob) → drop
- `gog_wcs_plugin_config` = Risk control/strike → drop
- `ClientCheckGetExtInfo` = Device info collection → drop
- `revokemsg` = Message recall notification → **keep** (if `passRevokemsg: true`)

## Sync Response Structure

```json
{
  "Code": 0,
  "Success": true,
  "Data": {
    "AddMsgs": [...],          // Incremental messages
    "ModContacts": [...],      // Contact updates (cache these)
    "ModUserInfos": [...],     // Self user info (contains wxid)
    "KeyBuf": {                // NEXT Synckey — pass this back
      "iLen": 349,
      "buffer": "base64..."   // Protobuf-encoded sync cursor
    },
    "Continue": 711176314,     // Continuation cookie
    "ContinueFlag": 18874624,  // Non-zero = more data to fetch
    "Time": 1775677433         // Server timestamp
  }
}
```

## Key Design Decisions

- **NormalizedMessage** unifies WS and Sync message formats so `channel.ts` doesn't care about transport
- **Contact cache** built from `ModContacts` in Sync responses; used for sender name resolution
- **Dedup by `NewMsgId`** (not `MsgId` — `MsgId` can repeat across sessions, `NewMsgId` is globally unique)
- **`readOnly` mode** blocks all outbound sends — for account stability during initial period
- **Age filter** drops messages older than `maxMessageAge` seconds (default 180) to avoid replaying stale history

## Config Reference

```json
{
  "channels": {
    "wechatpadpro": {
      "host": "192.168.50.231",
      "port": 8062,
      "authcode": "...",           // Required for sync/websocket mode
      "adminKey": "...",           // Required for WS mode only
      "syncMode": "websocket",    // "ws" | "sync" | "websocket" (auto-detected from authcode → sync)
      "wsUrl": "ws://172.24.16.104:8089/ws/sync",  // Optional: custom WS URL for websocket mode
      "syncInterval": 5000,       // Poll interval in ms (sync mode only)
      "readOnly": true,           // Receive-only, no sending
      "dmSecurity": "allow-all",  // "allowlist" | "allow-all" | "pairing"
      "allowFrom": ["wxid_xxx"],  // DM allowlist
      "allowMsgTypes": [1,3,34,47,49],
      "passRevokemsg": true,
      "maxMessageAge": 180
    }
  }
}
```

## Potential API Implementations (from WCPP MAX API surface)

Based on the available WeChatPadProMAX API, here are candidates for implementation in priority order:

### Implemented ✓
| API | Use Case | Status |
|-----|----------|--------|
| `POST /Msg/Quote` | Reply to/quote messages | ✅ Implemented — maps OpenClaw `reply_to` to WeChat quote |

### High Priority — Core Messaging
| API | Use Case | Notes |
|-----|----------|-------|
| `POST /Msg/Revoke` | Revoke sent messages | User command `/revoke` or auto-revoke on edit |
| `POST /Tools/DownloadVoice` | Download voice messages (MsgType 34) | Currently only receive CDN URL, need decryption |
| `POST /Tools/DownloadImg` | Download HD images | Current images are thumbnails/CDN refs |
| `POST /Tools/DownloadVideo` | Download video files | For video messages (MsgType 43?) |
| `POST /Msg/SendVoice` | Send voice messages | File upload → voice message |
| `POST /Msg/SendVideo` | Send video messages | File upload → video message |
| `POST /Msg/UploadImg` | Upload and send images | Current `SendImageNewMessage` may be limited |

### Medium Priority — Group & Contact Features
| API | Use Case |
|-----|----------|
| `POST /Group/GetChatRoomMemberDetail` | Better @ mention resolution (names instead of wxids) |
| `POST /Group/GetChatRoomInfoDetail` | Group announcements, topic, metadata |
| `POST /Friend/GetContractDetail` | Rich contact profiles |
| `POST /Friend/SetRemarks` | Set friend备注 |
| `POST /Group/SendPat` | "拍一拍" nudge functionality |

### Low Priority / Niche
| API | Use Case |
|-----|----------|
| `POST /Msg/SendApp` | Forward app/card messages |
| `POST /Msg/SendXCX` | Mini program messages |
| `POST /Msg/ShareCard` | Share contact cards |
| `POST /Msg/ShareLink` | Rich link previews |
| `POST /TenPay/*` | Red envelopes (probably not needed) |
| `POST /FriendCircle/*` | Moments/朋友圈 (read-only might be interesting) |

### Webhook Integration
| API | Use Case |
|-----|----------|
| `GET /Webhook/Get` | Get current webhook config |
| `POST /Webhook/Set` | Configure webhook callback URL |
| `POST /Webhook/Remove` | Remove webhook config |
| `POST /Webhook/Test` | Test webhook delivery |
| `GET /Webhook/Business/Get` | Get business callback URL |
| `POST /Webhook/Business/Set` | Set business callback URL |

**Note:** These are server-side webhook configurations. The plugin can optionally expose a local HTTP endpoint for WCPP MAX to push messages to, instead of polling `/Msg/Sync`.

### Out of Scope (server admin responsibility)
All `/Login/*`, `/Admin/*`, `/User/*` account management APIs.

## Known Issues

- Sync polling may return duplicate `PushContent` for the same message (reported by users in the WCPP community) — dedup handles this
- WCPP MAX authcode is single-use per login session; if the server restarts, a new authcode may be needed
- `@bot` detection in group chats relies on `<atuserlist>` in `MsgSource` XML — some clients may not include this
- Voice messages (MsgType 34) contain CDN URLs that require decryption (`aeskey`) — downloading/playing is not implemented yet
