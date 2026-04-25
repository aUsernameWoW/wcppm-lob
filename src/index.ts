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
    // Manual catch-up trigger: send one Sync request frame over the already-open
    // WebSocket. WCPPM pushes any new data back via the same WS, going through
    // our normal inbound handler. Reach via `openclaw gateway call wechatpadpro.forceSync`.
    api.registerGatewayMethod(
      "wechatpadpro.forceSync",
      async ({ respond }: { respond: (ok: boolean, payload?: unknown) => void }) => {
        const client = getWcppClient();
        if (!client) {
          respond(false, { error: "channel not running" });
          return;
        }
        const result = client.forceSync();
        respond(result.triggered, result);
      },
    );
  },
});
