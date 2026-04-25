/**
 * Main entry point for the WeChatPadPro channel plugin.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { wechatpadproPlugin, getWcppClient } from "./channel.js";

console.error("[wcpp-debug] index.ts module loaded");

export default defineChannelPluginEntry({
  id: "wechatpadpro",
  name: "WeChatPadPro",
  description: "OpenClaw channel plugin for WeChat via WeChatPadPro / WeChatPadProMax",
  plugin: wechatpadproPlugin,
  registerCliMetadata(api: any) {
    console.error(`[wcpp-debug] registerCliMetadata called, mode=${api?.registrationMode}`);
  },
  registerFull(api: any) {
    console.error(`[wcpp-debug] registerFull called, mode=${api?.registrationMode}, hasRegisterGatewayMethod=${typeof api?.registerGatewayMethod === "function"}`);
    // Manual catch-up trigger: drain a single /api/Msg/Sync round (following
    // ContinueFlag) into the normal inbound pipeline. WS push is the base
    // transport, so this is the operator's escape hatch when push has gone
    // quiet but the WCPPM longlink is still up. No web-UI button surface
    // exists today (channel cards in OpenClaw's UI are hard-coded), so this
    // is reachable via `openclaw gateway call wechatpadpro.forceSync`.
    api.registerGatewayMethod(
      "wechatpadpro.forceSync",
      async ({ respond }: { respond: (ok: boolean, payload?: unknown) => void }) => {
        console.error("[wcpp-debug] forceSync handler invoked");
        const client = getWcppClient();
        if (!client) {
          respond(false, { error: "channel not running" });
          return;
        }
        try {
          const drained = await client.forceSync();
          respond(true, { drained });
        } catch (err) {
          respond(false, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    );
  },
});
