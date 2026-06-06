/**
 * Main entry point for the WeChatPadPro channel plugin.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { wechatpadproPlugin, getWcppClient } from "./channel.js";

export default defineChannelPluginEntry({
  id: "wechatpadpro",
  name: "WeChatPadPro",
  description: "OpenClaw channel plugin for WeChat via WeChatPadPro / WeChatPadProMax",
  plugin: wechatpadproPlugin,
  registerFull(api: any) {
    // Manual catch-up trigger: one HTTP /api/Msg/Sync round. New messages flow
    // through the normal dedup + filter + dispatch pipeline. Independent of
    // /Login/Newinit (which drives the real-time push pipeline; Sync is a
    // separate on-demand pull). NO loop — operator re-invokes if hasMore.
    // Reach via `openclaw gateway call wechatpadpro.forceSync`.
    api.registerGatewayMethod(
      "wechatpadpro.forceSync",
      async ({ respond }: { respond: (ok: boolean, payload?: unknown) => void }) => {
        const client = getWcppClient();
        if (!client) {
          respond(false, { error: "channel not running" });
          return;
        }
        const result = await client.forceSync();
        respond(result.ok, result);
      },
    );
  },
});
