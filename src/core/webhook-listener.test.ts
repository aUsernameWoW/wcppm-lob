import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { createWebhookListener, type WebhookSink } from "./webhook-listener.js";
import type { WebhookEnvelope } from "./client.js";
import type { WebhookListenerConfig } from "./config.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const SECRET = "shared-secret";
const FIXED_NOW_MS = 1_700_000_000_000;
const FRESH_TS = Math.floor(FIXED_NOW_MS / 1000); // within the skew window

function cfg(extra?: Partial<WebhookListenerConfig>): WebhookListenerConfig {
  return {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    path: "/webhook",
    secret: SECRET,
    debug: false,
    silentDropUnsigned: false,
    ...extra,
  };
}

function sign(env: Omit<WebhookEnvelope, "Signature">, secret = SECRET): WebhookEnvelope {
  const input = `${env.Wxid}:${env.MessageType}:${env.Timestamp}`;
  const Signature = createHmac("sha256", secret).update(input).digest("hex");
  return { ...env, Signature };
}

function envelope(wxid: string, ts = FRESH_TS): WebhookEnvelope {
  return sign({
    MessageType: "sync_message",
    Timestamp: ts,
    Wxid: wxid,
    IsSelf: false,
    Data: { messages: [] },
  });
}

/** Capturing sink factory. */
function makeSinks() {
  const got: Array<{ account: string; wxid: string }> = [];
  const sinks: Record<string, WebhookSink> = {
    wxid_a: { account: "acctA", ingestWebhookEnvelope: (e) => got.push({ account: "acctA", wxid: e.Wxid }) },
    wxid_b: { account: "acctB", ingestWebhookEnvelope: (e) => got.push({ account: "acctB", wxid: e.Wxid }) },
  };
  return { got, route: (wxid: string) => sinks[wxid] };
}

async function withListener(
  config: WebhookListenerConfig,
  route: (wxid: string) => WebhookSink | undefined,
  body: () => Promise<void> | void,
  now = () => FIXED_NOW_MS,
): Promise<void> {
  const listener = createWebhookListener({ config, log: noopLog, route, now });
  const port = await listener.listen();
  (withListener as unknown as { port: number }).port = port;
  try {
    await body();
  } finally {
    await listener.close();
  }
}

function post(port: number, payload: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("webhook-listener: routes a valid signed push to the sink matching envelope.Wxid", async () => {
  const { got, route } = makeSinks();
  await withListener(cfg(), route, async () => {
    const port = (withListener as unknown as { port: number }).port;
    const res = await post(port, envelope("wxid_b"));
    assert.equal(res.status, 200);
    await res.json();
    assert.deepEqual(got, [{ account: "acctB", wxid: "wxid_b" }]);
  });
});

test("webhook-listener: rejects a bad signature (401) and does not ingest", async () => {
  const { got, route } = makeSinks();
  await withListener(cfg(), route, async () => {
    const port = (withListener as unknown as { port: number }).port;
    const bad = { ...envelope("wxid_a"), Signature: "deadbeef" };
    const res = await post(port, bad);
    assert.equal(res.status, 401);
    assert.deepEqual(got, []);
  });
});

test("webhook-listener: an unknown Wxid is acked (200) but not ingested", async () => {
  const { got, route } = makeSinks();
  await withListener(cfg(), route, async () => {
    const port = (withListener as unknown as { port: number }).port;
    const res = await post(port, envelope("wxid_unknown"));
    assert.equal(res.status, 200);
    const json = (await res.json()) as { dropped?: boolean };
    assert.equal(json.dropped, true);
    assert.deepEqual(got, []);
  });
});

test("webhook-listener: a stale timestamp is dropped (benign backlog), not ingested", async () => {
  const { got, route } = makeSinks();
  const staleTs = FRESH_TS - 4000; // > 900s old
  await withListener(cfg(), route, async () => {
    const port = (withListener as unknown as { port: number }).port;
    const res = await post(port, envelope("wxid_a", staleTs));
    assert.equal(res.status, 200);
    assert.deepEqual(got, []);
  });
});
