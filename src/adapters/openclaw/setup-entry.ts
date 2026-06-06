/**
 * Setup entry point — lightweight loading during onboarding.
 */

import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { wechatpadproPlugin } from "./channel.js";

export default defineSetupPluginEntry(wechatpadproPlugin);
