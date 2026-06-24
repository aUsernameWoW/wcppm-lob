# Inbound File Attachments → OpenClaw (MsgType 49 / appmsg type 6)

**Date:** 2026-06-24
**Status:** Approved, pre-implementation
**Branch (planned):** `feat/inbound-file-attachments`

## Problem

A WeChat **file** message (e.g. `症状.docx`) reaches the middleware and is broadcast,
but OpenClaw renders it as a useless placeholder — `[卡片] 症状.docx` — and the file
bytes are never delivered. The agent cannot open the document.

Observed in production (2026-06-24). A single file send produces **two** inbound
messages for the same document:

| msgId | appmsg `<type>` | Downloadable? | Why |
|-------|-----------------|---------------|-----|
| `1520091361` | `74` | **No** | Only a `fileuploadtoken`; no `attachid`/`cdnattachurl`/`aeskey`. This is the *"uploading…"* placeholder. |
| `1144397471` | `6`  | **Yes** | Carries `attachid`, `cdnattachurl`, `aeskey`, `totallen`, `fileext`, plus `<appmsg appid="…">`. The completed file. |

Today `formatInboundDisplayText` (`core/client.ts`) only special-cases appType `57`
(quote) and `5` (link card). Everything else — including files — falls through to
`[卡片] <title>`. No `FrameMedia` is produced, so no download path exists.

### Secondary bug (in scope, independent)

The same log shows the agent's reply failing:

```
[send] no instance for account=undefined
[send] to=gxnnycz replyTo=- ok=false
```

**Root cause:** `shared/bridge-client.ts` `send()` sets `body.account` *only when
`req.account` is explicitly provided*, but `adapters/openclaw/channel.ts` `sendText`
calls `b.send({to, text, replyTo})` without an account. The middleware then runs
`instanceFor(undefined)`, which resolves only when exactly one instance is configured;
under the multi-instance deploy (>1 instance) it returns nothing and the reply is
dropped. `fetchMedia`/`getHistory`/`getContacts` already default to the connection's
configured `account` — `send` is the only call that forgot.

## Goal

Deliver inbound WeChat file attachments to OpenClaw as real, downloadable files: the
middleware downloads the bytes on demand (after the adapter's gate) and hands the agent
a local `MediaPath` plus the correct `MediaType`, so the agent can read the document.
Fix the reply-send `account` regression along the way.

**Non-goals:** outbound file send (middleware `/send` stays text-only); rendering the
transient type-74 placeholder (it is suppressed).

## Approach

Reuse the existing **lazy-media pipeline** that already serves images. A file frame
advertises `media.kind:"file"`; the adapter pulls the bytes via `POST /media` *after*
its gate (so only files we'd actually dispatch are downloaded), and the middleware
downloads via the WCPPM `/Tools/DownloadFile` endpoint.

Rejected alternatives:
- **Eager download at ingest** — downloads files nobody replies to; wastes bandwidth
  and widens the active-call surface; breaks the codebase's "fetch only after the gate"
  rule.
- **Text-only + CDN URL** — the docx is AES-encrypted on CDN; the agent can't open it.
  Fails the goal.

## Account-safety note

`/Tools/DownloadFile` is in the **safe `/Tools` family** (same as the existing
image/voice/video downloads), **not** a banned `/Login` or `/Msg/Sync` surface. Adding
it introduces no account-ban risk. A bounded section loop (see below) only fires on a
file the agent already decided to dispatch.

## Design

### 1. Wire contract — `src/shared/frame.ts`

Add `"file"` to `FrameMedia.kind`:

```ts
kind: "image" | "voice" | "video" | "file";
```

`mimeType` (derived from `fileext`) and `fileName` (from `<title>`, e.g. `症状.docx`)
already exist on `FrameMedia`. No new fields.

### 2. Middleware extract + download — `src/core/client.ts`

**`extractFileMessageInfo(message): FileMessageInfo | null`** — return non-null only for
MsgType 49 with appmsg `<type>6</type>`. Extract:

- `attachId` ← `<appattach><attachid>` (the `@cdn_…` value)
- `cdnAttachUrl` ← `<cdnattachurl>`
- `aesKey` ← `<aeskey>`
- `totalLen` ← `<totallen>` (→ `dataLen`)
- `fileExt` ← `<fileext>`
- `title` ← `<title>` (the display filename)
- `appId` ← `<appmsg appid="…">` attribute
- `fromUserName` ← message `FromUserName`/`fromUser`
- `msgId`

Returns `null` (so it is **not** treated as a file) for:
- appType `74` — no `<attachid>` (uploading placeholder; also suppressed upstream, §5)
- appType `57` (quote) and `5` (link card)
- any non-49 message

**`downloadFile(message, outputPath?)`** — `POST /api/Tools/DownloadFile` via the existing
`downloadMediaEndpoint`, payload:

```jsonc
{ "appID": appId, "attachId": attachId, "dataLen": totalLen,
  "userName": fromUserName, "sectionStart": 0, "sectionLen": <chunk> }
```

Attempt a single-shot download (`sectionStart:0`, `sectionLen:totalLen`). If the server
caps section size and returns a partial buffer, fall back to a **bounded section loop**
that advances `sectionStart` by the returned length and concatenates chunks until
`totalLen` bytes are collected (hard cap on iterations to avoid a runaway loop). The
exact single-vs-loop behaviour is resolved during TDD against the live/mocked API; the
code must handle both.

**`buildAttachmentCandidate`** — add a `"file"` kind: `mimeType` from `fileExt`
(map common types — `docx`, `pdf`, `xlsx`, `pptx`, `zip`, … — fallback
`application/octet-stream`); `extension` = `.${fileExt}`; `fileName` = a filesystem-safe
form of `title`, or `wechat-file-${msgId}.${fileExt}` when absent.

**`resolveMedia`** — add a `file` branch (after voice/image/video). No type conflict:
file is MsgType 49, the others are 3/34/43/62.

### 3. Frame mapping — `src/core/frame.ts`

Extend `intrinsicMedia(msg)`: for `msg.msgType === 49`, peek the appmsg `<type>`; when it
is `6`, return `{ kind:"file", mimeType, fileName }` derived from the appmsg `fileext`
and `title`. (A minimal local regex peek keeps `frame.ts` pure — no client dependency,
matching how it already infers `image` from msgType alone.) type-74 yields no media.

The existing media descriptor persisted by `ingest.ts`
(`{MsgId, MsgType, FromUserName, Content}`) already carries everything
`extractFileMessageInfo` needs — **no DB or ingest change** for files.

### 4. Display text — `src/core/client.ts`

In `formatInboundDisplayText`, before the catch-all `[卡片]`:

```ts
if (appType === "6" || appType === "74") return title ? `[文件] ${title}` : "[文件]";
```

So even on a download miss the text is accurate, and the type-74 placeholder (if it ever
reaches text formatting) reads sensibly.

### 5. Suppress the type-74 placeholder

The `<type>74</type>` "uploading…" message is transient and non-downloadable; the real
type-6 message follows within seconds. Drop it before broadcast so OpenClaw never sees a
duplicate, useless attachment. Implemented in the client ingest/normalize path as a
**broadcast/dispatch** suppression consistent with existing filters — **storage is
unaffected** (the lossless-store rule still holds; type-74 is simply never surfaced to
subscribers). The precise hook (normalize returns null vs. a surfaced-but-not-broadcast
flag) is chosen to match the existing MsgType-filter style in `ingestSyncMessages`.

### 6. Adapter — `src/adapters/openclaw/dispatch.ts` + `channel.ts`

- Widen the `mediaKind` union to include `"file"` (in both `dispatch.ts` and `channel.ts`).
- **Forward `MediaType`.** Today `dispatch.ts` sets only `MediaPath`; a docx handed over
  with no type could be mistaken for an image. Extend the adapter `fetchMedia` result to
  carry `mimeType`/`fileName` (the bridge client already returns them — they are just
  dropped today) and set `MediaType` (the mime) in the agent context payload alongside
  `MediaPath`.

### 7. Send-account fix — `src/shared/bridge-client.ts`

In `send()`, default the account to the connection's configured account, mirroring
`fetchMedia`/`getHistory`:

```ts
body.account = req.account ?? account;   // was: only set when req.account !== undefined
```

This makes the agent's reply route to the correct instance under the multi-instance
deploy. No change needed in `channel.ts` (the per-account `bridge` already knows its
account).

## Data flow (file)

```
WeChat file (MsgType 49, appmsg type 6)
  → client normalize: text "[文件] 症状.docx", media kind "file"   (type-74 suppressed)
  → ingest: persist frame + media descriptor (unchanged shape)
  → broadcast Frame{ media:{kind:"file", mimeType, fileName} }
  → adapter gate passes → POST /media
  → middleware fetchMedia → resolveMedia(file) → downloadFile → materialize → localPath
  → adapter sets MediaPath + MediaType → agent reads the .docx
  → agent reply → bridge send (account defaulted) → POST /send → correct instance → WeChat
```

## Testing (TDD — write the failing test first)

Use the **exact** type-6 and type-74 XML from the 2026-06-24 log as fixtures.

**`core/client.ts`**
- `extractFileMessageInfo` returns the full field set for type-6; `null` for type-74,
  type-57, type-5, and non-49 messages.
- `downloadFile` builds the correct `/Tools/DownloadFile` payload (mock
  `downloadMediaEndpoint`); section-loop accumulates chunks to `totalLen`.
- `formatInboundDisplayText` → `[文件] 症状.docx` for type-6 and type-74.
- `resolveMedia` returns `kind:"file"` for a type-6 message.
- type-74 is suppressed from broadcast/dispatch but still stored.

**`core/frame.ts`**
- `intrinsicMedia` / `buildFrame` yields `media.kind:"file"` for type-6, none for type-74.

**`adapters/openclaw/dispatch.ts`**
- a `file` frame sets both `MediaPath` and `MediaType` in the agent payload.

**`shared/bridge-client.ts`**
- `send({to,text})` with no explicit account posts `account` = the connection's account.

## Open risk

`/Tools/DownloadFile` section semantics (single-shot vs. chunk loop, exact response
envelope/base64 wrapping) are confirmed empirically during TDD. Mitigated by the
single-shot-then-bounded-loop design and the existing `extractDownloadBuffer` envelope
handling.
