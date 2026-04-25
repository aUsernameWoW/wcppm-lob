/**
 * Type shim for openclaw/plugin-sdk/direct-dm-access.
 *
 * Real implementation lives in the host openclaw runtime; we only need
 * enough surface for tsc. See /home/radxa/openclaw-source-codes for the
 * concrete types.
 */

export type DirectDmDecision = "allow" | "block" | "pairing";

export type ResolvedInboundDirectDmAccess = {
  access: {
    decision: DirectDmDecision;
    reasonCode: string;
    reason: string;
    effectiveAllowFrom: string[];
  };
  shouldComputeAuth: boolean;
  senderAllowedForCommands: boolean;
  commandAuthorized: boolean | undefined;
};

export type DirectDmCommandAuthorizationRuntime = {
  shouldComputeCommandAuthorized: (rawBody: string, cfg: any) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: any) => boolean;
};

export declare function resolveInboundDirectDmAccessWithRuntime(params: {
  cfg: any;
  channel: string;
  accountId: string;
  dmPolicy?: string | null;
  allowFrom?: Array<string | number> | null;
  senderId: string;
  rawBody: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
  runtime: DirectDmCommandAuthorizationRuntime;
  modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  readStoreAllowFrom?: (provider: string, accountId: string) => Promise<string[]>;
}): Promise<ResolvedInboundDirectDmAccess>;

export declare function createPreCryptoDirectDmAuthorizer(params: {
  resolveAccess: (
    senderId: string,
  ) => Promise<
    | { access: ResolvedInboundDirectDmAccess["access"] }
    | ResolvedInboundDirectDmAccess
  >;
  issuePairingChallenge?: (params: {
    senderId: string;
    reply: (text: string) => Promise<void>;
  }) => Promise<void>;
  onBlocked?: (params: { senderId: string; reason: string; reasonCode: string }) => void;
}): (input: {
  senderId: string;
  reply: (text: string) => Promise<void>;
}) => Promise<DirectDmDecision>;
