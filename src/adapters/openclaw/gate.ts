/**
 * gate.ts — pre-dispatch inbound frame gate, SDK-free so it is unit-testable
 * (channel.ts/dispatch.ts import openclaw/plugin-sdk, which only exists as
 * typecheck shims here).
 *
 * Two checks, both about not burning agent tokens on traffic we will never
 * answer:
 *
 * - self-echo: the middleware broadcasts the bot's own *group* messages back
 *   (it only drops own DMs — storage stays lossless). Dispatching an echo
 *   makes the agent spend a model call deciding to ignore its own words.
 *
 * - group allowlist: dmSecurity/allowFrom gates DMs only; without this,
 *   every chatroom the WeChat account sits in streams straight into the
 *   agent pipeline. Empty list = block all groups; "*" = allow all.
 */

import type { Frame } from "../../shared/frame.js";

export type GateVerdict =
  | { action: "dispatch" }
  | { action: "drop"; reason: "self-echo" | "group-not-allowed" };

export function evaluateInboundFrame(
  frame: Pick<Frame, "chatType" | "from" | "chat">,
  opts: { selfWxid: string | null; groupAllowFrom: string[] },
): GateVerdict {
  if (opts.selfWxid && frame.from.wxid === opts.selfWxid) {
    return { action: "drop", reason: "self-echo" };
  }
  if (frame.chatType === "group") {
    const allowed = opts.groupAllowFrom.some(
      (entry) => entry === "*" || entry === frame.chat.id,
    );
    if (!allowed) return { action: "drop", reason: "group-not-allowed" };
  }
  return { action: "dispatch" };
}
