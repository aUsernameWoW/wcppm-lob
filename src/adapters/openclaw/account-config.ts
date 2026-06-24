/**
 * account-config.ts — SDK-free account resolution for the wechatpadpro channel.
 *
 * Extracted from channel.ts so the multi-account config logic (the `accounts`
 * map + per-account override merge) is unit-testable: channel.ts imports
 * openclaw/plugin-sdk, which only exists here as typecheck shims, so anything
 * importing it cannot run under tsx. This module depends only on a plain config
 * shape (structurally compatible with OpenClawConfig).
 */

export const DEFAULT_ACCOUNT_ID = "default";

export interface ResolvedAccount {
  accountId: string | null;
  /** WS base URL of the middleware, e.g. ws://127.0.0.1:8077 */
  bridgeUrl: string;
  /** Bearer token shared with the middleware. */
  bridgeToken?: string;
  /** Middleware account id to subscribe as (== accountId unless overridden). */
  account: string;
  allowFrom: string[];
  /** Group ids (…@chatroom) whose messages may reach the agent. Empty = block all groups; "*" = allow all. */
  groupAllowFrom: string[];
  dmPolicy: string | undefined;
}

/** Minimal structural shape of OpenClawConfig that this module needs. */
export interface ChannelConfigLike {
  channels?: Record<string, any>;
}

export function readSection(cfg: ChannelConfigLike): Record<string, any> | undefined {
  return cfg.channels?.["wechatpadpro"];
}

/** The `accounts` map (OpenClaw multi-account convention), or {} when absent. */
export function readAccounts(cfg: ChannelConfigLike): Record<string, any> {
  return (readSection(cfg)?.accounts as Record<string, any>) ?? {};
}

/**
 * Account ids the gateway should start: the keys of `accounts`, or the single
 * "default" account for a flat (no `accounts` map) section. Empty when the
 * channel section is absent entirely.
 */
export function listAccountIds(cfg: ChannelConfigLike): string[] {
  const section = readSection(cfg);
  if (!section) return [];
  const ids = Object.keys(readAccounts(cfg));
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

/**
 * Resolve one account by id, merging its `accounts[id]` entry over the base
 * section. The middleware subscribe `account` defaults to the OpenClaw accountId
 * (the "accountId == account label" convention) unless the entry overrides it.
 */
export function resolveAccount(cfg: ChannelConfigLike, accountId?: string | null): ResolvedAccount {
  const section = readSection(cfg) ?? {};
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const perAccount = (section.accounts as Record<string, any>)?.[id] ?? {};
  const merged = { ...section, ...perAccount };

  return {
    accountId: id,
    bridgeUrl: merged.bridgeUrl,
    bridgeToken: merged.bridgeToken,
    account: merged.account ?? id,
    allowFrom: merged.allowFrom ?? [],
    groupAllowFrom: merged.groupAllowFrom ?? [],
    dmPolicy: merged.dmSecurity,
  };
}

/** Configured = we can reach the middleware: bridgeUrl + bridgeToken present. */
export function isConfigured(account: ResolvedAccount | undefined): boolean {
  if (!account) return false;
  return Boolean(account.bridgeUrl) && Boolean(account.bridgeToken);
}
