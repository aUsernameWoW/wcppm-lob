/**
 * db.ts — SQLite-backed state for the middleware (node:sqlite, no native dep).
 *
 * Two tables (see design spec §5):
 *   inbound_log — dedup (INSERT OR IGNORE on the globally-unique id) + replay/ack log
 *   contacts    — contact/group name cache (rebuildable)
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface InboundEntry {
  id: string; // NewMsgId — globally unique
  account: string;
  ts: number; // server time (seconds), for age window + ordering
  payload: string; // the normalized JSON frame pushed to subscribers
}

export interface InboundRow extends InboundEntry {
  delivered_at: number | null;
}

export interface MediaEntry {
  id: string; // message id (NewMsgId) — same key space as inbound_log
  account: string;
  kind: string; // "image" | "voice" | "video"
  /** JSON descriptor sufficient to re-run the WeChat media download on demand. */
  descriptor: string;
  ts: number; // server time (seconds), for retention pruning
}

export interface MediaRow {
  id: string;
  account: string;
  kind: string;
  descriptor: string;
  ts: number;
}

export interface ContactEntry {
  account: string;
  wxid: string;
  name: string;
  type?: string; // "friend" | "group" | ...
  extra?: string; // optional JSON blob
  updatedAt: number;
}

export interface ContactRow {
  account: string;
  wxid: string;
  name: string;
  type: string | null;
  extra: string | null;
  updated_at: number;
}

export interface Db {
  /** INSERT OR IGNORE the inbound row. Returns true if newly inserted, false if it was a duplicate. */
  recordInbound(entry: InboundEntry): boolean;
  /** Mark a row as delivered (acked by a subscriber) at the given time. No-op if (account,id) unknown. */
  markDelivered(account: string, id: string, deliveredAt: number): void;
  /** Replay set: un-acked rows for an account with ts >= sinceTs (the age window), oldest first. */
  getUndelivered(account: string, sinceTs: number): InboundRow[];
  /** Single inbound row by (account, id), or undefined. Used to recover quote context. */
  getInbound(account: string, id: string): InboundRow | undefined;
  /** Retention: delete inbound rows with ts < cutoff. Returns how many were removed. */
  pruneInbound(cutoffTs: number): number;
  /** INSERT OR IGNORE a media descriptor (lazy-fetch). Returns true if newly inserted. */
  recordMedia(entry: MediaEntry): boolean;
  /** Look up a media descriptor by (account, id), or undefined if unknown/pruned. */
  getMedia(account: string, id: string): MediaRow | undefined;
  /** Retention: delete media rows with ts < cutoff. Returns how many were removed. */
  pruneMedia(cutoffTs: number): number;
  /** Insert or update a cached contact/group, keyed by (account, wxid). */
  upsertContact(contact: ContactEntry): void;
  /** Look up a cached contact/group, or undefined if not cached. */
  getContact(account: string, wxid: string): ContactRow | undefined;
  /** Read-only: contacts matching wxid/name substring `q`, newest-updated first. Empty q → all in account. */
  searchContacts(account: string, q: string, limit: number): ContactRow[];
  /** Read-only: most-recent inbound rows for an account, newest first. */
  recentInbound(account: string, limit: number): InboundRow[];
  close(): void;
}

/**
 * Rebuild `table` to a composite (account, id) PK if it currently exists with an
 * id-only PK. `columns` is the shared column list (same order in old and new tables);
 * `createSql` creates the new composite-PK table. Preserves all rows. No-op when the
 * table is absent (fresh DB) or already on the composite PK.
 */
function migrateToCompositePk(db: DatabaseSync, table: string, columns: string, createSql: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
  if (cols.length === 0) return; // table doesn't exist yet — CREATE IF NOT EXISTS will make it fresh
  const pkCols = cols.filter((c) => Number(c.pk) > 0).map((c) => c.name);
  const alreadyComposite = pkCols.length === 2 && pkCols.includes("account") && pkCols.includes("id");
  if (alreadyComposite) return;

  db.exec(`
    ALTER TABLE ${table} RENAME TO ${table}_old;
    ${createSql}
    INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table}_old;
    DROP TABLE ${table}_old;
  `);
}

export function openDb(path: string): Db {
  // SQLite creates the db file but NOT its parent directory — ensure it exists.
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);

  // Migration: older databases keyed inbound_log/media on `id` alone. Since a WeChat
  // NewMsgId is only unique WITHIN one account, that PK silently dropped a second
  // account's identical id. Rebuild such tables to a composite (account, id) PK,
  // preserving every existing row. Idempotent: a no-op on fresh or already-migrated DBs.
  migrateToCompositePk(db, "inbound_log", "id, account, ts, payload, delivered_at", `
    CREATE TABLE inbound_log (
      id           TEXT NOT NULL,
      account      TEXT NOT NULL,
      ts           INTEGER NOT NULL,
      payload      TEXT NOT NULL,
      delivered_at INTEGER,
      PRIMARY KEY (account, id)
    );`);
  migrateToCompositePk(db, "media", "id, account, kind, descriptor, ts", `
    CREATE TABLE media (
      id         TEXT NOT NULL,
      account    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      descriptor TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      PRIMARY KEY (account, id)
    );`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS inbound_log (
      id           TEXT NOT NULL,
      account      TEXT NOT NULL,
      ts           INTEGER NOT NULL,
      payload      TEXT NOT NULL,
      delivered_at INTEGER,
      PRIMARY KEY (account, id)
    );
    CREATE INDEX IF NOT EXISTS idx_inbound_replay ON inbound_log (account, delivered_at, ts);

    CREATE TABLE IF NOT EXISTS media (
      id         TEXT NOT NULL,
      account    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      descriptor TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      PRIMARY KEY (account, id)
    );
    CREATE INDEX IF NOT EXISTS idx_media_ts ON media (ts);

    CREATE TABLE IF NOT EXISTS contacts (
      account    TEXT NOT NULL,
      wxid       TEXT NOT NULL,
      name       TEXT NOT NULL,
      type       TEXT,
      extra      TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account, wxid)
    );
  `);

  const insertInbound = db.prepare(
    "INSERT OR IGNORE INTO inbound_log (id, account, ts, payload) VALUES (?, ?, ?, ?)",
  );
  const markDeliveredStmt = db.prepare(
    "UPDATE inbound_log SET delivered_at = ? WHERE account = ? AND id = ?",
  );
  const undeliveredStmt = db.prepare(
    "SELECT id, account, ts, payload, delivered_at FROM inbound_log" +
      " WHERE account = ? AND delivered_at IS NULL AND ts >= ? ORDER BY ts ASC",
  );
  const getInboundStmt = db.prepare(
    "SELECT id, account, ts, payload, delivered_at FROM inbound_log WHERE account = ? AND id = ?",
  );
  const pruneStmt = db.prepare("DELETE FROM inbound_log WHERE ts < ?");
  const insertMediaStmt = db.prepare(
    "INSERT OR IGNORE INTO media (id, account, kind, descriptor, ts) VALUES (?, ?, ?, ?, ?)",
  );
  const getMediaStmt = db.prepare(
    "SELECT id, account, kind, descriptor, ts FROM media WHERE account = ? AND id = ?",
  );
  const pruneMediaStmt = db.prepare("DELETE FROM media WHERE ts < ?");
  const upsertContactStmt = db.prepare(
    "INSERT INTO contacts (account, wxid, name, type, extra, updated_at) VALUES (?, ?, ?, ?, ?, ?)" +
      " ON CONFLICT(account, wxid) DO UPDATE SET" +
      " name = excluded.name, type = excluded.type, extra = excluded.extra, updated_at = excluded.updated_at",
  );
  const getContactStmt = db.prepare(
    "SELECT account, wxid, name, type, extra, updated_at FROM contacts WHERE account = ? AND wxid = ?",
  );
  const searchContactsStmt = db.prepare(
    "SELECT account, wxid, name, type, extra, updated_at FROM contacts" +
      " WHERE account = ? AND (wxid LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT ?",
  );
  const recentInboundStmt = db.prepare(
    "SELECT id, account, ts, payload, delivered_at FROM inbound_log" +
      " WHERE account = ? ORDER BY ts DESC LIMIT ?",
  );

  return {
    recordInbound(entry) {
      const r = insertInbound.run(entry.id, entry.account, entry.ts, entry.payload);
      return Number(r.changes) === 1;
    },
    markDelivered(account, id, deliveredAt) {
      markDeliveredStmt.run(deliveredAt, account, id);
    },
    getUndelivered(account, sinceTs) {
      return undeliveredStmt.all(account, sinceTs) as unknown as InboundRow[];
    },
    getInbound(account, id) {
      return getInboundStmt.get(account, id) as InboundRow | undefined;
    },
    pruneInbound(cutoffTs) {
      return Number(pruneStmt.run(cutoffTs).changes);
    },
    recordMedia(entry) {
      const r = insertMediaStmt.run(entry.id, entry.account, entry.kind, entry.descriptor, entry.ts);
      return Number(r.changes) === 1;
    },
    getMedia(account, id) {
      return getMediaStmt.get(account, id) as MediaRow | undefined;
    },
    pruneMedia(cutoffTs) {
      return Number(pruneMediaStmt.run(cutoffTs).changes);
    },
    upsertContact(contact) {
      upsertContactStmt.run(
        contact.account,
        contact.wxid,
        contact.name,
        contact.type ?? null,
        contact.extra ?? null,
        contact.updatedAt,
      );
    },
    getContact(account, wxid) {
      return getContactStmt.get(account, wxid) as ContactRow | undefined;
    },
    searchContacts(account, q, limit) {
      const escaped = q.replace(/[\\%_]/g, "\\$&");
      const like = `%${escaped}%`;
      return searchContactsStmt.all(account, like, like, limit) as unknown as ContactRow[];
    },
    recentInbound(account, limit) {
      return recentInboundStmt.all(account, limit) as unknown as InboundRow[];
    },
    close() {
      db.close();
    },
  };
}
