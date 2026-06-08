/**
 * ingest.ts — the inbound pipeline core (testable apart from the live client/server).
 *
 * For each NormalizedMessage the client surfaces: build the wire Frame, persist
 * it to inbound_log (which doubles as the durable dedup), and — only if it's new
 * — cache the contact and broadcast it to subscribers. main.ts wires the real
 * WcppClient.onMessage to this with a real db + the server's broadcast.
 */
import type { NormalizedMessage } from "./client.js";
import type { Frame } from "../shared/frame.js";
import type { Db } from "./db.js";
import type { Logger } from "../shared/logger.js";
import { buildFrame } from "./frame.js";

export interface IngestDeps {
  account: string;
  db: Pick<Db, "recordInbound" | "upsertContact">;
  broadcast: (frame: Frame) => void;
  log: Logger;
  /** Optional name lookup (real impl wraps client.getContact). */
  resolveName?: (wxid: string) => string | undefined;
  /**
   * Max message age (seconds) eligible for *broadcast* to subscribers. Every new
   * message is still persisted regardless of age; this only gates the agent
   * dispatch so a backlog redelivery / cold-Sync history batch is stored without
   * replaying stale messages as live auto-replies. Undefined → dispatch all.
   */
  maxBroadcastAge?: number;
  /** Clock (ms epoch) for the broadcast-age check; defaults to Date.now. Injectable for tests. */
  now?: () => number;
}

/**
 * Returns true if the message was new (recorded — and broadcast when recent
 * enough), false if it was a duplicate. A new-but-too-old message is persisted
 * and returns true, but is not broadcast (see maxBroadcastAge).
 */
export function handleInbound(msg: NormalizedMessage, deps: IngestDeps): boolean {
  const { account, db, broadcast, resolveName, log, maxBroadcastAge, now } = deps;
  const frame = buildFrame(msg, { account });

  // Per-message trace (debug-only; the steady-state inbound path is otherwise
  // silent at info). Logged before dedup so every message that reaches the
  // pipeline leaves a footprint regardless of outcome.
  log.debug(
    `[in] recv id=${frame.id} ${frame.chatType} from=${frame.from.wxid}` +
      (frame.chatType === "group" ? ` chat=${frame.chat.id}` : "") +
      (frame.media ? ` media=${frame.media.kind}` : ""),
  );

  // Fill names from the contact cache only where buildFrame didn't already
  // derive one from pushContent (pushContent takes precedence, as before).
  if (resolveName) {
    if (!frame.from.name) {
      const fromName = resolveName(frame.from.wxid);
      if (fromName) frame.from.name = fromName;
    }
    if (frame.chatType === "group" && !frame.chat.name) {
      const chatName = resolveName(frame.chat.id);
      if (chatName) frame.chat.name = chatName;
    }
  }

  const isNew = db.recordInbound({
    id: frame.id,
    account,
    ts: frame.ts,
    payload: JSON.stringify(frame),
  });
  if (!isNew) {
    log.debug(`[in] dup id=${frame.id}, dropping`);
    return false;
  }

  // Cache the sender (and the group, for group chats) for future name resolution.
  db.upsertContact({
    account,
    wxid: frame.from.wxid,
    name: frame.from.name ?? frame.from.wxid,
    type: frame.chatType === "group" ? "member" : "friend",
    updatedAt: frame.ts,
  });
  if (frame.chatType === "group") {
    db.upsertContact({
      account,
      wxid: frame.chat.id,
      name: frame.chat.name ?? frame.chat.id,
      type: "group",
      updatedAt: frame.ts,
    });
  }

  // Recency gate: the message is already persisted above. Only dispatch it to
  // subscribers if it is recent enough — so backlog redeliveries / cold-Sync
  // history are stored losslessly without firing stale auto-replies downstream.
  if (maxBroadcastAge !== undefined) {
    const ageSec = (now ? now() : Date.now()) / 1000 - frame.ts;
    if (ageSec > maxBroadcastAge) {
      log.debug(`[in] stored id=${frame.id} age=${Math.round(ageSec)}s > ${maxBroadcastAge}s; persisted, not dispatched`);
      return true;
    }
  }

  broadcast(frame);
  log.debug(`[in] broadcast id=${frame.id}`);
  return true;
}
