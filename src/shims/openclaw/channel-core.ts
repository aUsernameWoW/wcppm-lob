/**
 * Type shim for openclaw/plugin-sdk/channel-core
 *
 * This provides just enough types for the plugin to compile standalone.
 * At runtime, OpenClaw provides the real implementations.
 */

export interface OpenClawConfig {
  channels?: Record<string, any>;
  [key: string]: any;
}

export interface Logger {
  info: (...args: any[]) => void;
  error: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  debug: (...args: any[]) => void;
}

export interface ChannelPluginBase {
  id: string;
  setup: {
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => any;
    inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
      enabled: boolean;
      configured: boolean;
      tokenStatus: string;
    };
  };
}

export interface ChannelPlugin {
  id: string;
  setup: ChannelPluginBase["setup"];
  security?: any;
  threading?: any;
  outbound?: any;
}

export function createChannelPluginBase(opts: {
  id: string;
  setup: ChannelPluginBase["setup"];
}): ChannelPluginBase {
  return opts as any;
}

export function createChatChannelPlugin<TAccount>(opts: {
  base: ChannelPluginBase;
  security?: any;
  threading?: any;
  outbound?: any;
}): ChannelPlugin {
  return opts as any;
}

export function defineChannelPluginEntry(opts: any): any {
  return opts;
}

export function defineSetupPluginEntry(plugin: ChannelPlugin): any {
  return { plugin };
}
