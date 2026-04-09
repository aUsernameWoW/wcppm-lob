# TODO

## Highest priority

- Wire media materialization into real OpenClaw inbound attachment ingestion
- Add configurable auto-ingest policy for inbound media:
  - off / manual / selected kinds
  - size limits
  - temp file retention policy
- Validate `downloadVoice()` / `downloadImage()` / `downloadVideo()` against real API responses and lock down payload/response schemas

## Messaging

- Add outbound voice sending support
- Add outbound video sending support
- Add richer image sending path if `UploadImg` is more correct than current flow
- Consider revoke support, low priority unless a real product need appears

## Transport

- Keep `/Msg/Sync` as production default
- Keep `websocket` mode experimental until server-side webhook / dispatch chain is confirmed healthy
- Investigate why WS `101` upgrades immediately close with `1006`
- Verify whether WCPP MAX WebSocket push depends on webhook configuration

## Media

- Implement direct CDN media decrypt/playback when `voiceurl` / CDN URL + `aeskey` path is understood
- Improve MIME / extension inference from real responses
- Surface downloaded media as first-class OpenClaw attachments instead of attachment-ready metadata only

## Safety / ops

- Avoid initialization for this production account
- Document clearly that `/Msg/Sync` works without initialization
- Avoid unnecessary active operations during account nurturing / recovery

## Nice to have

- Group member nickname enrichment for media / quote contexts
- Better card/appmsg rendering
- Optional local media cache keyed by `msgId` / `NewMsgId`
