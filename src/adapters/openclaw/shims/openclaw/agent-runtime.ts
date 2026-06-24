/**
 * Type shim for openclaw/plugin-sdk/agent-runtime.
 *
 * Only the surface the adapter uses. Real impl: src/agents/identity.ts in the
 * host openclaw runtime (resolveHumanDelayConfig).
 */

import type { OpenClawConfig } from "./channel-core.js";

/** Inter-block reply pacing config, resolved from agent defaults + per-agent override. */
export type HumanDelayConfig = {
  mode?: "off" | "natural" | "custom";
  minMs?: number;
  maxMs?: number;
};

export declare function resolveHumanDelayConfig(
  cfg: OpenClawConfig,
  agentId: string,
): HumanDelayConfig | undefined;
