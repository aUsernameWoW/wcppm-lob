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
import { buildFrame } from "./frame.js";

export interface IngestDeps {
  account: string;
  db: Pick<Db, "recordInbound" | "upsertContact">;
  broadcast: (frame: Frame) => void;
  /** Optional name lookup (real impl wraps client.getContact). */
  resolveName?: (wxid: string) => string | undefined;
}

/** Returns true if the message was new (recorded + broadcast), false if it was a duplicate. */
export function handleInbound(msg: NormalizedMessage, deps: IngestDeps): boolean {
  const { account, db, broadcast, resolveName } = deps;
  const frame = buildFrame(msg, { account });

  if (resolveName) {
    const fromName = resolveName(frame.from.wxid);
    if (fromName) frame.from.name = fromName;
    if (frame.chatType === "group") {
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
  if (!isNew) return false;

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

  broadcast(frame);
  return true;
}
