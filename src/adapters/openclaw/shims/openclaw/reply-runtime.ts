/**
 * Type shim for openclaw/plugin-sdk/reply-runtime.
 *
 * Real implementations live in the host openclaw runtime; we only need enough
 * surface here for tsc to pass. All payload shapes are `any`-leaning to keep
 * the shim small — see /home/radxa/openclaw-source-codes for actual types.
 */

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
  audioAsVoice?: boolean;
  isError?: boolean;
  isReasoning?: boolean;
  isCompactionNotice?: boolean;
  channelData?: Record<string, unknown>;
  [k: string]: unknown;
};

export type MsgContext = Record<string, any>;
export type FinalizedMsgContext = Record<string, any>;

export declare function finalizeInboundContext(ctx: MsgContext): FinalizedMsgContext;

export declare function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: any;
  dispatcher: any;
  replyOptions?: any;
  replyResolver?: any;
}): Promise<{ queuedFinal: boolean; counts: { tool: number; block: number; final: number } }>;

export declare function createReplyDispatcherWithTyping(opts: {
  deliver: (payload: ReplyPayload, info: { kind: "tool" | "block" | "final" }) => Promise<void>;
  responsePrefix?: string;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
  typingCallbacks?: any;
  humanDelay?: any;
  onError?: (err: unknown, info: { kind: "tool" | "block" | "final" }) => void;
  onIdle?: () => void;
  onCleanup?: () => void;
  onReplyStart?: () => Promise<void> | void;
  [k: string]: unknown;
}): {
  dispatcher: any;
  replyOptions: any;
  markDispatchIdle: () => void;
  markRunComplete: () => void;
};
