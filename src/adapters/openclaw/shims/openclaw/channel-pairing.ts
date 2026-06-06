/**
 * Type shim for openclaw/plugin-sdk/channel-pairing.
 *
 * Real implementation lives in the host openclaw runtime. See
 * /home/radxa/openclaw-source-codes/src/plugin-sdk/channel-pairing.ts.
 */

export type ChannelPairingController = {
  issueChallenge: (params: {
    senderId: string;
    senderIdLine: string;
    meta?: Record<string, string | undefined>;
    sendPairingReply: (text: string) => Promise<void>;
    buildReplyText?: (params: { code: string; senderIdLine: string }) => string;
    onCreated?: (params: { code: string }) => void;
    onReplyError?: (err: unknown) => void;
  }) => Promise<{ created: boolean; code?: string }>;
  [k: string]: any;
};

export declare function createChannelPairingController(params: {
  core: any;
  channel: string;
  accountId: string;
}): ChannelPairingController;
