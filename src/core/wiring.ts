/**
 * wiring.ts — small testable seams used by main.ts to connect the WcppClient
 * to the bridge server. main.ts itself is thin bootstrap glue (config load,
 * process signals, network) and is verified by build + manual e2e; the bits
 * with real branching logic live here so they can be unit-tested.
 */

export interface SendCapableClient {
  sendText(to: string, text: string): Promise<boolean>;
  sendQuote(to: string, text: string, referMsgId: string, referToUserName?: string): Promise<boolean>;
}

export interface SendRequest {
  account?: string;
  to: string;
  text: string;
  replyTo?: string;
}

/**
 * Build the `send` handler for ServerDeps: route to sendQuote when replyTo is
 * set (mapping it to the WeChat refer-msg-id), otherwise plain sendText.
 */
export function createSendHandler(
  client: SendCapableClient,
): (req: SendRequest) => Promise<{ ok: boolean; msgId?: string }> {
  return async (req) => {
    const ok = req.replyTo
      ? await client.sendQuote(req.to, req.text, req.replyTo)
      : await client.sendText(req.to, req.text);
    return { ok };
  };
}

// ---------------------------------------------------------------------------
// Lazy media fetch
// ---------------------------------------------------------------------------

interface ResolvedMediaLike {
  kind: string;
  materialize(dir?: string): Promise<{ filePath: string; mimeType: string; fileName: string }>;
}

export interface MediaCapableClient {
  /** Re-resolves a media message into a downloadable handle (see WcppClient.resolveMedia). */
  resolveMedia(message: any): ResolvedMediaLike | null;
}

export interface MediaDescriptorStore {
  /** Returns the stored lazy-fetch descriptor for a media message, or undefined. */
  getMedia(account: string, id: string): { kind: string; descriptor: string } | undefined;
}

export interface MediaFetchResult {
  ok: boolean;
  localPath?: string;
  mimeType?: string;
  fileName?: string;
}

/**
 * Build the `fetchMedia` handler for ServerDeps: look up the descriptor stored
 * at ingest time, reconstruct the minimal message, download the bytes to a
 * local file, and return its path. Any miss or download error degrades to
 * { ok: false } so a failed image never blocks the (already-delivered) text.
 *
 * `opts.dir` is the download directory; when omitted the client's materialize
 * default (an OS-tmp subdir) is used — fine because the middleware and the
 * subscriber share a filesystem (same box).
 */
export function createMediaFetcher(
  client: MediaCapableClient,
  store: MediaDescriptorStore,
  opts: { dir?: string; log?: { warn: (...a: unknown[]) => void; debug: (...a: unknown[]) => void } } = {},
): (account: string, id: string) => Promise<MediaFetchResult> {
  const log = opts.log;
  return async (account, id) => {
    const row = store.getMedia(account, id);
    if (!row) {
      // No descriptor: pruned, never stored, or unknown id. Visible at debug —
      // this is an expected outcome (e.g. fetching an aged-out media frame).
      log?.debug(`[media] no descriptor for account=${account} id=${id}`);
      return { ok: false };
    }
    try {
      const message = JSON.parse(row.descriptor);
      const resolved = client.resolveMedia(message);
      if (!resolved) {
        log?.warn(`[media] descriptor for ${id} did not resolve to downloadable media (kind=${row.kind})`);
        return { ok: false };
      }
      const m = await resolved.materialize(opts.dir);
      return { ok: true, localPath: m.filePath, mimeType: m.mimeType, fileName: m.fileName };
    } catch (err) {
      // Log the REAL reason at warn (HTTP 404, bad param, …) — the download
      // error is otherwise swallowed and the agent just silently loses the image.
      log?.warn(`[media] fetch failed for ${id}: ${String(err)}`);
      return { ok: false };
    }
  };
}
