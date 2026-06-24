/**
 * Type shim for openclaw/plugin-sdk/channel-inbound-debounce.
 *
 * Only the surface the adapter uses. Real impl: src/auto-reply/inbound-debounce.ts
 * in the host openclaw runtime. Coalesces a burst of inbound items per key, then
 * fires onFlush with the buffered list (caller merges); window resolved from
 * cfg.messages.inbound.{debounceMs,byChannel}.
 */

import type { OpenClawConfig } from "./channel-core.js";

export type InboundDebounceCreateParams<T> = {
  debounceMs: number;
  maxTrackedKeys?: number;
  /** Coalescing key; null/undefined/empty → item is dispatched immediately, unbuffered. */
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  resolveDebounceMs?: (item: T) => number | undefined;
  /** Fired with the full buffered list (NOT a merged item) — caller merges + dispatches once. */
  onFlush: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
};

export declare function createInboundDebouncer<T>(params: InboundDebounceCreateParams<T>): {
  /** Push an inbound item (fire-and-forget; per-key ordering preserved). */
  enqueue: (item: T) => Promise<void>;
  /** Force-flush a key's pending buffer now. */
  flushKey: (key: string) => Promise<void>;
};

export declare function resolveInboundDebounceMs(params: {
  cfg: OpenClawConfig;
  channel: string;
  overrideMs?: number;
}): number;
