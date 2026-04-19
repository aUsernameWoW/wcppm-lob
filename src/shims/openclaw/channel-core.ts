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
  setup: any;
  config?: any;
  configSchema?: any;
  meta?: any;
  capabilities?: any;
  gateway?: any;
}

export interface ChannelPlugin extends ChannelPluginBase {
  security?: any;
  threading?: any;
  outbound?: any;
}

export function createChannelPluginBase(opts: {
  id: string;
  setup: ChannelPluginBase["setup"];
  config?: any;
  configSchema?: any;
  meta?: any;
  capabilities?: any;
  gateway?: any;
}): ChannelPluginBase {
  return opts as any;
}

export function createChatChannelPlugin<_TAccount>(opts: {
  base: ChannelPluginBase;
  security?: any;
  threading?: any;
  outbound?: any;
}): ChannelPlugin {
  // The real openclaw runtime spreads `base` onto the returned plugin so
  // top-level lookups like `plugin.config.listAccountIds` work. Mirror that here.
  const { base, ...rest } = opts;
  return { ...base, ...rest } as any;
}

export function defineChannelPluginEntry(opts: any): any {
  return opts;
}

export function defineSetupPluginEntry(plugin: ChannelPlugin): any {
  return { plugin };
}
