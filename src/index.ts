/**
 * Main entry point for the WeChatPadPro channel plugin.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { wechatpadproPlugin } from "./channel.js";

export default defineChannelPluginEntry({
  id: "wechatpadpro",
  name: "WeChatPadPro",
  description: "OpenClaw channel plugin for WeChat via WeChatPadPro / WeChatPadProMax",
  plugin: wechatpadproPlugin,
  registerFull(api) {
    // TODO: register gateway method for login QR code display
    // TODO: register HTTP route for webhook if needed
  },
});
