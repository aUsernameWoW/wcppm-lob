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

import { WcppClient, type WcppConfig } from "./client.js";
import type { NormalizedMessage } from "./client.js";
import type { Logger } from "../shared/logger.js";

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
