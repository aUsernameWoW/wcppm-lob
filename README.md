# WeChatPadPro OpenClaw Channel Plugin

OpenClaw channel plugin for WeChat via [WeChatPadPro](https://github.com/WeChatPadPro/WeChatPadPro) / WeChatPadProMAX (iPad protocol).

## Features

- Private chat (DM) and group chat support with `chatType` distinction
- Three sync modes: WebSocket (standard WCPP), HTTP Sync polling, and WebSocket push (WCPP MAX)
- Text, image, voice, sticker, location, link/card, quote/reply message receiving
- Text and image message sending, with quote/reply support
- @mention detection in group chats
- Media pipeline: voice/image/video metadata extraction, download helpers, attachment-ready output
- Contact/group metadata caching from Sync responses
- Message dedup, age filtering, MsgType filtering
- Read-only mode for account safety
- DM security: allowlist, allow-all, or pairing mode
- Auto-reconnect on WebSocket disconnect

## Installation

Clone into your OpenClaw extensions directory and install dependencies:

```bash
git clone <repo-url> ~/.openclaw/extensions/wcppm-lob
cd ~/.openclaw/extensions/wcppm-lob
npm install
npm run build
```

## Prerequisites

This plugin does **not** handle login or authentication. The WeChatPadProMAX server must already be logged in and online. You need a valid `authcode` (for MAX) or `adminKey` + `authKey` (for standard WCPP) from the server admin.

## Configuration

Add to your `openclaw.json`:

```json
{
  "channels": {
    "wechatpadpro": {
      "host": "192.168.50.231",
      "port": 8062,
      "authcode": "your-authcode",
      "syncMode": "websocket",
      "wsUrl": "ws://your-server:8089/ws/sync",
      "readOnly": true,
      "dmSecurity": "allow-all",
      "allowFrom": ["wxid_xxx"],
      "allowMsgTypes": [1, 3, 34, 47, 48, 49],
      "passRevokemsg": true,
      "maxMessageAge": 180
    }
  }
}
```

### Config Options

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `host` | string | Yes | | WeChatPadPro server host |
| `port` | number | | `8062` | Server port |
| `adminKey` | string | WS mode | | Admin key for standard WCPP WS mode |
| `authcode` | string | sync/websocket mode | | Auth code for WCPP MAX |
| `syncMode` | string | | auto | `"ws"`, `"sync"`, or `"websocket"` (auto-detected from authcode) |
| `wsUrl` | string | | auto | Custom WebSocket URL for websocket mode |
| `syncInterval` | number | | `5000` | Poll interval in ms (sync mode only) |
| `readOnly` | boolean | | `false` | Receive-only, block all outbound sends |
| `dmSecurity` | string | | `"allowlist"` | `"allowlist"`, `"allow-all"`, or `"pairing"` |
| `allowFrom` | string[] | | `[]` | wxid allowlist for DMs |
| `allowMsgTypes` | number[] | | `[1,3,34,47,48,49]` | MsgTypes to pass through |
| `passRevokemsg` | boolean | | `true` | Pass through message recall notifications |
| `maxMessageAge` | number | | `180` | Drop messages older than this many seconds |
| `wxid` | string | | | WeChat ID (auto-detected from sync responses) |
| `replyWithMention` | boolean | | `false` | @sender in group replies |
| `proxy` | string | | | Proxy URL (e.g. `socks5://...`) |

## Sync Modes

| Mode | Transport | Use Case |
|------|-----------|----------|
| `ws` | WebSocket | Standard WeChatPadPro (requires `adminKey`) |
| `sync` | HTTP polling | WeChatPadProMAX (requires `authcode`) |
| `websocket` | WebSocket push | WeChatPadProMAX (requires `authcode`, recommended) |

## Message Types

### Inbound

| MsgType | Description | Display |
|---------|-------------|---------|
| 1 | Text (including built-in emoji like `[Facepalm]`) | Raw text |
| 3 | Image | `[图片]` |
| 34 | Voice | `[语音] 3s` |
| 47 | Sticker/emoji (creator, custom GIF) | `[表情]` |
| 48 | Location | `[位置] POI名称` |
| 49 (type 5) | Link card (articles, Xiaohongshu, etc.) | `[链接] 标题` |
| 49 (type 57) | Quote/reply | `[引用] 标题` |
| 49 (type 3) | Music share | `[卡片] 标题` |
| 10002 | Message recall (if `passRevokemsg: true`) | `[撤回] 提示` |

### Outbound

| Method | Description |
|--------|-------------|
| `sendText` | Text messages |
| `sendImage` | Image messages (base64) |
| `sendQuote` | Quote/reply messages |

## Development

```bash
npm install
npm run build    # one-time compile
npm run dev      # watch mode
```

## License

MIT
