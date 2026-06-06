/**
 * Type shim for openclaw/plugin-sdk/channel-reply-pipeline.
 */

import type { OpenClawConfig } from "./channel-core.js";

export declare function createChannelReplyPipeline(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel?: string;
  accountId?: string;
  typing?: any;
  typingCallbacks?: any;
  transformReplyPayload?: any;
}): Record<string, any>;
