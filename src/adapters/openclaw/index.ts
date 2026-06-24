/**
 * Main entry point for the WeChatPadPro channel plugin.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { wechatpadproPlugin, getBridgeClient } from "./channel.js";

export default defineChannelPluginEntry({
  id: "wechatpadpro",
  name: "WeChatPadPro",
  description: "OpenClaw channel plugin for WeChat via WeChatPadPro / WeChatPadProMax",
  plugin: wechatpadproPlugin,
  registerFull(api: any) {
    // Manual catch-up trigger: proxies to the middleware's POST /forceSync
    // (one HTTP /api/Msg/Sync round on the middleware side). NO loop — operator
    // re-invokes if hasMore. Reach via `openclaw gateway call wechatpadpro.forceSync`.
    api.registerGatewayMethod(
      "wechatpadpro.forceSync",
      async ({ params, respond }: { params?: { account?: string }; respond: (ok: boolean, payload?: unknown) => void }) => {
        // With multiple accounts running, the operator passes { account } to pick
        // one; omitted is fine when exactly one account is running.
        const client = getBridgeClient(params?.account);
        if (!client) {
          respond(false, { error: params?.account ? `account not running: ${params.account}` : "channel not running (specify account)" });
          return;
        }
        const result = await client.forceSync();
        respond(result.ok, result);
      },
    );
  },
});
