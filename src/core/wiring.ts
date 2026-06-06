/**
 * wiring.ts — small testable seams used by main.ts to connect the WcppClient
 * to the bridge server. main.ts itself is thin bootstrap glue (config load,
 * process signals, network) and is verified by build + manual e2e; the bits
 * with real branching logic live here so they can be unit-tested.
 */

export interface SendCapableClient {
  sendText(to: string, text: string): Promise<boolean>;
  sendQuote(to: string, text: string, referMsgId: string, referToUserName?: string): Promise<boolean>;
}

export interface SendRequest {
  account?: string;
  to: string;
  text: string;
  replyTo?: string;
}

/**
 * Build the `send` handler for ServerDeps: route to sendQuote when replyTo is
 * set (mapping it to the WeChat refer-msg-id), otherwise plain sendText.
 */
export function createSendHandler(
  client: SendCapableClient,
): (req: SendRequest) => Promise<{ ok: boolean; msgId?: string }> {
  return async (req) => {
    const ok = req.replyTo
      ? await client.sendQuote(req.to, req.text, req.replyTo)
      : await client.sendText(req.to, req.text);
    return { ok };
  };
}
