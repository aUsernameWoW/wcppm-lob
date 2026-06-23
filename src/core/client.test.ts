/**
 * client.test.ts — TDD tests for WcppClient inbound bring-up.
 *
 * Focus: the webhook listener must be started exactly once. A regression where
 * both connect() and the bootstrap (main.ts) started it caused the webhook
 * server to listen(port) twice → EADDRINUSE crash. These tests pin the contract
 * (connect() owns webhook bring-up) and the safety net (startWebhookServer() is
 * idempotent), so a duplicate start can never crash the process again.
 *
 * Uses node:test + node:assert/strict. All servers bind 127.0.0.1 on a free
 * ephemeral port; no WCPPM network access (host:"" → passive webhook-only mode).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { WcppClient, type WcppConfig, extractDownloadBuffer } from "./client.js";
import type { NormalizedMessage } from "./client.js";
import type { Logger } from "../shared/logger.js";

// --- media download helpers ------------------------------------------------

test("extractImageMessageInfo: parses attribute-form image XML (aeskey/cdn urls as <img> attrs)", () => {
  const client = new WcppClient({ host: "", port: 8062, authcode: "x" } as WcppConfig, {
    info() {}, warn() {}, error() {}, debug() {},
  } as Logger);
  const xml =
    '<msg><img aeskey="AESKEY123" encryver="1" cdnthumburl="THUMB" cdnmidimgurl="MID" length="121781" cdnbigimgurl="BIG" hdlength="1675551" md5="MD5HASH"/></msg>';
  const info = client.extractImageMessageInfo({
    MsgId: 1056300438,
    MsgType: 3,
    FromUserName: { string: "gxnnycz" },
    Content: { string: xml },
  } as any);
  assert.ok(info);
  assert.equal(info!.aesKey, "AESKEY123");
  assert.equal(info!.cdnBigImgUrl, "BIG");
  assert.equal(info!.cdnMidImgUrl, "MID");
  assert.equal(info!.fileLength, 121781);
  assert.equal(info!.msgId, 1056300438); // small MsgId (not NewMsgId)
});

test("extractDownloadBuffer: finds CdnDownloadImage bytes at Data.Image (base64)", () => {
  const want = Buffer.from("a fake jpeg payload long enough to clear the length guard", "utf8");
  const json = { Code: 0, Success: true, Data: { Image: want.toString("base64") } };
  const got = extractDownloadBuffer(json);
  assert.ok(got);
  assert.equal(got!.toString("utf8"), want.toString("utf8"));
});

test("extractDownloadBuffer: finds bytes at the nested Data.data.buffer (base64)", () => {
  const want = Buffer.from("hello image bytes that are long enough to pass the guard", "utf8");
  const json = { Code: 0, Success: true, Data: { msgId: 1, totalLen: 10, startPos: 0, data: { buffer: want.toString("base64") } } };
  const got = extractDownloadBuffer(json);
  assert.ok(got);
  assert.equal(got!.toString("utf8"), want.toString("utf8"));
});

test("extractDownloadBuffer: supports a numeric byte array and returns null when absent", () => {
  assert.deepEqual([...extractDownloadBuffer({ Data: { data: { buffer: [104, 105] } } })!], [104, 105]);
  assert.equal(extractDownloadBuffer({ Data: { msgId: 1, ok: true } }), null);
});

// --- helpers ---------------------------------------------------------------

interface RecordingLogger extends Logger {
  warnings: string[];
}

function makeLogger(): RecordingLogger {
  const warnings: string[] = [];
  return {
    info: () => {},
    error: () => {},
    debug: () => {},
    warn: (...args: any[]) => warnings.push(args.map(String).join(" ")),
    warnings,
  };
}

/** Grab a free TCP port by briefly binding :0, then releasing it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll the webhook /health endpoint until it answers (listen is async). */
async function awaitHealth(port: number, tries = 100): Promise<Response> {
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(`http://127.0.0.1:${port}/health`);
    } catch {
      await delay(10);
    }
  }
  throw new Error(`webhook /health on :${port} never came up`);
}

/** Passive webhook-only config (no host → no WS, no WCPPM network). */
function webhookOnlyConfig(port: number): WcppConfig {
  return {
    host: "",
    port: 0,
    webhookEnabled: true,
    webhookHost: "127.0.0.1",
    webhookPort: port,
  };
}

/** Spin up a fake WCPPM that answers POST /api/Msg/Sync with a fixed payload. */
async function fakeSyncServer(
  payload: unknown,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/api/Msg/Sync")) {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// --- tests -----------------------------------------------------------------

test("connect() is the single owner of webhook bring-up: webhook listens after connect()", async () => {
  const port = await freePort();
  const client = new WcppClient(webhookOnlyConfig(port), makeLogger());
  try {
    client.connect();
    const res = await awaitHealth(port);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  } finally {
    client.disconnect();
  }
});

test("WS push: a real 0416 syncData frame (Data.syncData IS SyncResponse.Data) is ingested", () => {
  // Captured off the live middleware socket (fd 24). The 0416 server wraps the
  // SyncResponse *Data* payload directly under Data.syncData — AddMsgs sits at
  // syncData's top level, and syncData has NO .Success / .Data of its own.
  // The old parser treated syncData as a full SyncResponse and dropped every
  // frame as "no recognizable inner SyncResponse". CreateTime is set to "now"
  // so the maxMessageAge filter never confounds the structural assertion.
  const client = new WcppClient({ host: "", port: 0 }, makeLogger());
  const got: NormalizedMessage[] = [];
  client.onMessage = (m) => got.push(m);

  const now = Math.floor(Date.now() / 1000);
  const frame = JSON.stringify({
    Code: 0,
    Success: true,
    Message: "",
    Data: {
      syncData: {
        ModUserInfos: null,
        ModContacts: null,
        DelContacts: null,
        ModUserImgs: null,
        FunctionSwitchs: null,
        UserInfoExts: null,
        AddMsgs: [
          {
            MsgId: 360536507,
            FromUserName: { string: "25280333867@chatroom" },
            ToUserName: { string: "wxid_e9y71dwz9fsh22" },
            MsgType: 1,
            Content: { string: "wxid_swjiiipvrk9u22:\nhello-from-ws" },
            Status: 3,
            ImgStatus: 1,
            ImgBuf: { iLen: 0 },
            CreateTime: now,
            MsgSource: "",
            // Real 19-digit id via Number() to dodge the ≥2^53 literal lint.
            NewMsgId: Number("7812319877321566199"),
            MsgSeq: 24403,
          },
        ],
      },
    },
  });

  client.handleWsMessage(frame);

  assert.equal(got.length, 1, "real syncData frame must emit exactly one message");
  assert.equal(got[0].text, "hello-from-ws");
  assert.equal(got[0].isGroup, true);
  assert.equal(got[0].senderWxid, "wxid_swjiiipvrk9u22");
});

test("WS push: a message older than the legacy age window is still emitted (storage-first; broadcast gating moved downstream to ingest)", () => {
  // Policy change (Option A): the client no longer drops by CreateTime age.
  // Every type/dedup-passing message is surfaced so the downstream pipeline can
  // persist it to SQLite; whether it reaches the agent (broadcast) is decided
  // later by ingest's maxBroadcastAge. So an hour-old message must NOT vanish.
  const client = new WcppClient({ host: "", port: 0 }, makeLogger());
  const got: NormalizedMessage[] = [];
  client.onMessage = (m) => got.push(m);

  const old = Math.floor(Date.now() / 1000) - 3600; // 1h old — far past the legacy 180s drop
  const frame = JSON.stringify({
    Code: 0,
    Success: true,
    Message: "",
    Data: {
      syncData: {
        AddMsgs: [
          {
            MsgId: 360536999,
            FromUserName: { string: "wxid_peer" },
            ToUserName: { string: "wxid_self" },
            MsgType: 1,
            Content: { string: "old-but-real" },
            CreateTime: old,
            MsgSource: "",
            NewMsgId: Number("7812319877321566200"),
            MsgSeq: 24404,
          },
        ],
      },
    },
  });

  client.handleWsMessage(frame);

  assert.equal(got.length, 1, "an old message must no longer be dropped by an age filter");
  assert.equal(got[0].text, "old-but-real");
});

test("startWebhookServer() is idempotent: a duplicate start does not crash and warns", async () => {
  const port = await freePort();
  const log = makeLogger();
  const client = new WcppClient(webhookOnlyConfig(port), log);
  try {
    client.startWebhookServer();
    // The regression: a second start used to listen(port) again → EADDRINUSE
    // (unhandled 'error' event crashes the process). It must now be a no-op.
    client.startWebhookServer();

    const res = await awaitHealth(port);
    assert.equal(res.status, 200);
    assert.ok(
      log.warnings.some((w) => /already running/i.test(w)),
      "expected a warning about the duplicate webhook start",
    );
  } finally {
    client.disconnect();
  }
});

test("forceSync on a '当前未有新消息' empty batch reports hasMore=false despite a non-zero ContinueFlag", async () => {
  // The 'no new messages' Sync response carries CmdList:{Count:0} (no AddMsgs)
  // and ContinueFlag:256 — a status bit, NOT a 'more backlog to drain' signal.
  // The old heuristic (ContinueFlag !== 0) made forceSync claim hasMore:true on
  // an empty round, which would mislead an operator into re-draining forever.
  const noNewMessages = {
    Code: 0,
    Success: true,
    Message: "当前未有新消息",
    Data: {
      Ret: 0,
      CmdList: { Count: 0 },
      ContinueFlag: 256,
      KeyBuf: { iLen: 8, buffer: "CC8SCAgB" },
      Status: 1,
      Continue: 1082291745,
      time: 1780858463,
    },
    Data62: "",
    Debug: "",
    CodeValue: "",
    ID: 0,
  };
  const srv = await fakeSyncServer(noNewMessages);
  const client = new WcppClient(
    { host: "127.0.0.1", port: srv.port, authcode: "test", proxy: "" },
    makeLogger(),
  );
  try {
    const result = await client.forceSync();
    assert.equal(result.ok, true, "an empty 'no new messages' batch is a successful sync");
    assert.equal(result.messages, 0, "an empty batch ingests zero messages");
    assert.equal(result.hasMore, false, "empty 'no new messages' batch must not report hasMore");
  } finally {
    await srv.close();
  }
});

test("webhook: a stale (timestamp-skew) doorbell is dropped quietly — accepted with no warn-level noise", async () => {
  // In 0416 the webhook is an empty doorbell; a stale one carries no message,
  // so it is dropped, but at debug (not warn) — it is benign background noise,
  // not something that needs attention. Still answered 200 so WCPPM drains it.
  const port = await freePort();
  const log = makeLogger();
  const client = new WcppClient(webhookOnlyConfig(port), log);
  try {
    client.connect();
    await awaitHealth(port);

    const stale = Math.floor(Date.now() / 1000) - 3600; // 1h old → trips the 900s window
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        MessageType: "sync_message",
        Timestamp: stale,
        Wxid: "wxid_self",
        IsSelf: false,
        Data: {},
      }),
    });

    assert.equal(res.status, 200, "a stale doorbell is still accepted (200) so WCPPM stops retrying it");
    assert.ok(
      !log.warnings.some((w) => /skew/i.test(w)),
      `a stale doorbell must not log at warn level; got ${JSON.stringify(log.warnings)}`,
    );
  } finally {
    client.disconnect();
  }
});
