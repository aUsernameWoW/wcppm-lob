import { fetch as undiciFetch } from "undici";
import { buildProxyTransport } from "../core/proxy.js";
import type { HeartbeatClient, HeartbeatResult } from "./conductor.js";
import type { Logger } from "../shared/logger.js";

/** Pure classifier: success iff Success===true AND Data.BaseResponse.ret===0.
 *  NOTE: Selector and NextTime are intentionally ignored (ban-safety — see plan constraints). */
export function classifyHeartbeat(json: unknown): HeartbeatResult {
  const j = json as any;
  const ret = j?.Data?.BaseResponse?.ret;
  const success = j?.Success === true && ret === 0;
  return { success, failOfTimeout: false };
}

export class WcppHeartbeatClient implements HeartbeatClient {
  private readonly dispatcher;
  // Store as undici's fetch type so dispatcher is accepted without suppression.
  private readonly fetchFn: typeof undiciFetch;
  private readonly timeoutMs: number;

  constructor(private opts: {
    baseUrl: string; authcode: string; proxy?: string; log: Logger;
    fetchImpl?: typeof fetch; timeoutMs?: number;
  }) {
    this.dispatcher = buildProxyTransport(opts.proxy).dispatcher;
    // Cast the injected stub (typed as global fetch) to undici fetch — identical
    // at runtime; the cast lets us pass dispatcher without a ts-expect-error.
    this.fetchFn = (opts.fetchImpl ?? undiciFetch) as typeof undiciFetch;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  private url(path: string): string {
    return `${this.opts.baseUrl}${path}?authcode=${this.opts.authcode}`;
  }

  async sendHeartbeat(): Promise<HeartbeatResult> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const res = await this.fetchFn(this.url("/api/Login/HeartBeat"), {
        method: "POST",
        headers: { accept: "application/json" },
        body: "",
        dispatcher: this.dispatcher,
        signal,
      });
      return classifyHeartbeat(await (res as any).json());
    } catch (e: any) {
      const timeout = e?.name === "AbortError" || e?.name === "TimeoutError";
      this.opts.log.warn(`[hb] heartbeat request error: ${e?.message ?? e}`);
      return { success: false, failOfTimeout: timeout };
    }
  }

  /** Longlink liveness cross-check — detect-don't-fix (spec §4). */
  async checkOnline(): Promise<boolean> {
    try {
      const res = await this.fetchFn(this.url("/api/User/GetOnlineInfo"), {
        method: "GET",
        headers: { accept: "application/json" },
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const j: any = await (res as any).json();
      const online = j?.Success === true;
      if (!online) {
        this.opts.log.error(
          `[hb-net] account appears offline (GetOnlineInfo) — longlink may be down; not auto-fixing`,
        );
      }
      return online;
    } catch (e: any) {
      this.opts.log.warn(`[hb-net] online check failed: ${e?.message ?? e}`);
      return false;
    }
  }
}
