# WeChatPadPro OpenClaw Channel Plugin

OpenClaw channel plugin for WeChat via [WeChatPadPro](https://github.com/WeChatPadPro/WeChatPadPro) / WeChatPadProMax (iPad protocol).

## Features

- Private chat (DM) and group chat support
- Text and image message sending/receiving
- @mention detection in group chats
- WebSocket-based real-time message receiving with auto-reconnect
- Credential persistence (auth key + wxid)
- DM security: allowlist, allow-all, or pairing mode

## Installation

```bash
openclaw plugins install @wcppm/openclaw-wechatpadpro
```

## Configuration

Add to your `openclaw.json`:

```json
{
  "channels": {
    "wechatpadpro": {
      "adminKey": "your-admin-key",
      "host": "your-wcpp-server",
      "port": 8080,
      "allowFrom": ["wxid_xxx"],
      "dmSecurity": "allowlist"
    }
  }
}
```

### Config Options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adminKey` | string | ✅ | WeChatPadPro admin key |
| `host` | string | ✅ | WeChatPadPro server host |
| `port` | number | ❌ | Server port (default: 8080) |
| `authKey` | string | ❌ | Pre-generated auth key (auto-generated if omitted) |
| `wxid` | string | ❌ | WeChat ID (persisted after login) |
| `allowFrom` | string[] | ❌ | wxid allowlist for DMs |
| `dmSecurity` | string | ❌ | `allowlist` (default), `allow-all`, or `pairing` |
| `replyWithMention` | boolean | ❌ | @sender in group replies (default: false) |
| `proxy` | string | ❌ | Proxy for login QR (e.g. `socks5://...`) |

## First-time Login

1. Configure `adminKey` and `host`
2. Start OpenClaw gateway
3. The plugin will generate an auth key and display a QR code URL
4. Scan with WeChat to log in
5. Credentials are saved for subsequent starts

## Message Types Supported

### Inbound
- Text (msg_type 1)
- Image (msg_type 3) — downloaded as base64
- Emoji/sticker (msg_type 47)
- Voice (msg_type 34) — basic support
- App messages / quotes (msg_type 49, type 57)

### Outbound
- Text (`SendTextMessage`)
- Image (`SendImageNewMessage`)
- Emoji (`SendEmojiMessage`)

## WeChatPadProMax

This plugin also works with WeChatPadProMax. The API surface is a superset;
additional Max endpoints can be added as needed.

## Development

```bash
npm install
npm run build
```

## License

MIT
