/**
 * Type shim for openclaw/plugin-sdk/routing.
 */

import type { OpenClawConfig } from "./channel-core.js";

export type ChatType = "direct" | "group";

export type RoutePeer = {
  kind: ChatType;
  id: string;
};

export type ResolveAgentRouteInput = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  peer?: RoutePeer | null;
  parentPeer?: RoutePeer | null;
  guildId?: string | null;
  teamId?: string | null;
  memberRoleIds?: string[];
};

export type ResolvedAgentRoute = {
  agentId: string;
  channel: string;
  accountId: string;
  sessionKey: string;
  mainSessionKey: string;
  lastRoutePolicy: "main" | "session";
  matchedBy: string;
};

export declare function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute;
