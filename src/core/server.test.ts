/**
 * server.test.ts — TDD tests for the BridgeServer downstream interface.
 *
 * Uses node:test, node:assert/strict, and the "ws" package (already installed).
 * All tests use ephemeral ports (listen on 0, read the bound port from httpServer.address()).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import type { Frame } from "../shared/frame.js";
import type { InboundRow } from "./db.js";
import { createBridgeServer, type ServerDeps } from "./server.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Fixed "now" for deterministic tests (ms since epoch). */
const FIXED_NOW_MS = 1_000_000_000_000; // arbitrary but stable
const FIXED_NOW_S = FIXED_NOW_MS / 1000;

/** Build a minimal ServerDeps with sensible defaults. Override per-test. */
function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    token: "test-token",
    db: {
      getUndelivered: (_account, _sinceTs) => [],
      markDelivered: (_id, _at) => {},
    },
    send: async (_req) => ({ ok: true, msgId: "fake-msg-id" }),
    forceSync: async (_account) => ({ ok: true, messages: 0, hasMore: false }),
    status: () => ({ wsUp: true, selfWxid: "wxid_test", lastMsgTs: FIXED_NOW_S }),
    selfWxid: () => "wxid_test",
    now: () => FIXED_NOW_MS,
    ...overrides,
  };
}

/**
 * ConnectedSocket wraps a WebSocket with a buffered message queue so we
 * can await messages that may have already arrived before the caller
 * attaches a listener. This avoids race conditions between the server
 * sending the ready frame synchronously and the test attaching a listener
 * after awaiting `connect()`.
 */
class ConnectedSocket {
  private _ws: WebSocket;
  private _msgQueue: unknown[] = [];
  private _msgWaiters: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  private _closed = false;
  private _closeCode = 0;
  private _closeReason = "";

  constructor(ws: WebSocket) {
    this._ws = ws;
    ws.on("message", (data: WebSocket.RawData) => {
      const parsed = JSON.parse(data.toString());
      if (this._msgWaiters.length > 0) {
        const waiter = this._msgWaiters.shift()!;
        waiter.resolve(parsed);
      } else {
        this._msgQueue.push(parsed);
      }
    });
    ws.on("close", (code: number, reason: Buffer) => {
      this._closed = true;
      this._closeCode = code;
      this._closeReason = reason.toString();
      // Reject all pending waiters
      for (const waiter of this._msgWaiters) {
        waiter.reject(new Error(`socket closed ${code} ${reason.toString()}`));
      }
      this._msgWaiters = [];
    });
  }

  /** Wait for the next message (from the queue or future events). */
  nextMessage(): Promise<unknown> {
    if (this._msgQueue.length > 0) {
      return Promise.resolve(this._msgQueue.shift()!);
    }
    if (this._closed) {
      return Promise.reject(new Error(`socket closed ${this._closeCode} ${this._closeReason}`));
    }
    return new Promise((resolve, reject) => {
      this._msgWaiters.push({ resolve, reject });
    });
  }

  get readyState() { return this._ws.readyState; }
  get raw() { return this._ws; }

  close() { this._ws.close(); }
  send(data: string) { this._ws.send(data); }

  waitClose(): Promise<{ code: number; reason: string }> {
    if (this._closed) return Promise.resolve({ code: this._closeCode, reason: this._closeReason });
    return new Promise((resolve) => {
      this._ws.once("close", (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString() });
      });
    });
  }
}

/** Open a WS connection, wait for it to be fully open, and return a ConnectedSocket. */
function connect(port: number, params: Record<string, string> = {}): Promise<ConnectedSocket> {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const url = `ws://127.0.0.1:${port}/subscribe${qs ? "?" + qs : ""}`;
    const ws = new WebSocket(url);
    // Create ConnectedSocket BEFORE open so message listener is attached immediately
    const cs = new ConnectedSocket(ws);
    ws.once("open", () => resolve(cs));
    ws.once("error", reject);
  });
}

/** Wait for a close event on a raw WebSocket (for auth rejection test). */
function waitRawClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** A minimal valid Frame for broadcast tests. */
function makeFrame(id = "frame-1"): Frame {
  return {
    type: "message",
    id,
    account: "default",
    chatType: "direct",
    from: { wxid: "wxid_sender", name: "Sender" },
    chat: { id: "wxid_sender" },
    text: "hello",
    mentionedMe: false,
    ts: FIXED_NOW_S,
  };
}

// ---------------------------------------------------------------------------
// Test 1: Auth — wrong token is rejected with close code 4401
// ---------------------------------------------------------------------------

test("auth: wrong token → WS closed with code 4401, correct token → connects", async () => {
  const deps = makeDeps();
  const server = createBridgeServer(deps);
  const port = await server.listen(0);

  try {
    // Wrong token
    const badWs = new WebSocket(`ws://127.0.0.1:${port}/subscribe?token=WRONG`);
    const closeEvt = await waitRawClose(badWs);
    assert.equal(closeEvt.code, 4401, "bad-token should close with 4401");

    // Correct token — should not close immediately
    const goodWs = await connect(port, { token: "test-token" });
    assert.equal(goodWs.readyState, WebSocket.OPEN);
    goodWs.close();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Test 2: Ready frame — first message after connect is a ReadyFrame
// ---------------------------------------------------------------------------

test("ready frame: first message after connect is {type:'ready',selfWxid}", async () => {
  const deps = makeDeps({ selfWxid: () => "wxid_me" });
  const server = createBridgeServer(deps);
  const port = await server.listen(0);

  try {
    const cs = await connect(port, { token: "test-token" });
    const first = await cs.nextMessage();

    assert.deepEqual(first, { type: "ready", selfWxid: "wxid_me" });
    cs.close();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Test 3: Replay on connect — after ready, replays undelivered rows in ts order
// ---------------------------------------------------------------------------

test("replay: undelivered rows sent after ready frame, both arrive, in ts order", async () => {
  const row1: InboundRow = {
    id: "id-1",
    account: "default",
    ts: FIXED_NOW_S - 100,
    payload: JSON.stringify({ type: "message", id: "id-1", text: "older" }),
    delivered_at: null,
  };
  const row2: InboundRow = {
    id: "id-2",
    account: "default",
    ts: FIXED_NOW_S - 50,
    payload: JSON.stringify({ type: "message", id: "id-2", text: "newer" }),
    delivered_at: null,
  };

  let capturedAccount: string | undefined;
  let capturedSinceTs: number | undefined;

  const deps = makeDeps({
    db: {
      getUndelivered(account, sinceTs) {
        capturedAccount = account;
        capturedSinceTs = sinceTs;
        return [row1, row2]; // already oldest-first
      },
      markDelivered: (_id, _at) => {},
    },
    ageWindowSeconds: 600,
  });

  const server = createBridgeServer(deps);
  const port = await server.listen(0);

  try {
    const cs = await connect(port, { token: "test-token", account: "default" });

    const ready = await cs.nextMessage();
    assert.equal((ready as any).type, "ready", "first message should be ready");

    const msg1 = await cs.nextMessage();
    const msg2 = await cs.nextMessage();

    assert.deepEqual(msg1, JSON.parse(row1.payload));
    assert.deepEqual(msg2, JSON.parse(row2.payload));

    // Verify the getUndelivered call parameters
    assert.equal(capturedAccount, "default");
    // sinceTs = now()/1000 - ageWindowSeconds = FIXED_NOW_MS/1000 - 600
    assert.equal(capturedSinceTs, FIXED_NOW_MS / 1000 - 600);

    cs.close();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Test 4: Ack — client sends {type:"ack",id:"x"} → server calls markDelivered
// ---------------------------------------------------------------------------

test("ack: client {type:'ack',id} triggers deps.db.markDelivered(id, now)", async () => {
  const calls: Array<{ id: string; deliveredAt: number }> = [];

  const deps = makeDeps({
    db: {
      getUndelivered: () => [],
      markDelivered(id, deliveredAt) {
        calls.push({ id, deliveredAt });
      },
    },
  });

  const server = createBridgeServer(deps);
  const port = await server.listen(0);

  try {
    const cs = await connect(port, { token: "test-token" });

    // Consume the ready frame
    await cs.nextMessage();

    // Send ack
    cs.send(JSON.stringify({ type: "ack", id: "msg-abc" }));

    // Give the server a tick to process
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "msg-abc");
    assert.equal(calls[0].deliveredAt, FIXED_NOW_MS);

    cs.close();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Test 5: Broadcast — server.broadcast() delivers frame to connected subscribers
// ---------------------------------------------------------------------------

test("broadcast: server.broadcast(frame) sends JSON to all connected subscribers", async () => {
  const deps = makeDeps();
  const server = createBridgeServer(deps);
  const port = await server.listen(0);

  try {
    const cs1 = await connect(port, { token: "test-token" });
    const cs2 = await connect(port, { token: "test-token" });

    // Consume ready frames
    await cs1.nextMessage();
    await cs2.nextMessage();

    assert.equal(server.subscriberCount(), 2);

    const frame = makeFrame("broadcast-1");
    const p1 = cs1.nextMessage();
    const p2 = cs2.nextMessage();
    server.broadcast(frame);

    const [got1, got2] = await Promise.all([p1, p2]);
    assert.deepEqual(got1, frame);
    assert.deepEqual(got2, frame);

    cs1.close();
    cs2.close();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Test 6: POST /send — valid token → calls deps.send, returns result; wrong token → 401
// ---------------------------------------------------------------------------

test("POST /send: valid token calls deps.send; wrong token → 401 and send NOT called", async () => {
  let sendCalled = false;
  let sentReq: any;

  const deps = makeDeps({
    send: async (req) => {
      sendCalled = true;
      sentReq = req;
      return { ok: true, msgId: "sent-id" };
    },
  });

  const server = createBridgeServer(deps);
  const port = await server.listen(0);

  try {
    // Valid token via Authorization header
    const body = { to: "wxid_bob", text: "hi there", account: "default" };
    const res = await fetch(`http://127.0.0.1:${port}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    const resBody = await res.json();
    assert.deepEqual(resBody, { ok: true, msgId: "sent-id" });
    assert.equal(sendCalled, true);
    assert.equal(sentReq.to, "wxid_bob");
    assert.equal(sentReq.text, "hi there");

    // Invalid token
    sendCalled = false;
    const res401 = await fetch(`http://127.0.0.1:${port}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer WRONG",
      },
      body: JSON.stringify(body),
    });
    assert.equal(res401.status, 401);
    assert.equal(sendCalled, false, "deps.send must NOT be called on auth failure");

    // Token via query param
    sendCalled = false;
    const res2 = await fetch(`http://127.0.0.1:${port}/send?token=test-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res2.status, 200);
    assert.equal(sendCalled, true);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Test 7: POST /forceSync — valid token → calls deps.forceSync
// ---------------------------------------------------------------------------

test("POST /forceSync: valid token calls deps.forceSync with body.account", async () => {
  let syncCalled = false;
  let syncAccount: string | undefined;

  const deps = makeDeps({
    forceSync: async (account) => {
      syncCalled = true;
      syncAccount = account;
      return { ok: true, messages: 5, hasMore: false };
    },
  });

  const server = createBridgeServer(deps);
  const port = await server.listen(0);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/forceSync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ account: "myaccount" }),
    });
    assert.equal(res.status, 200);
    const resBody = await res.json();
    assert.deepEqual(resBody, { ok: true, messages: 5, hasMore: false });
    assert.equal(syncCalled, true);
    assert.equal(syncAccount, "myaccount");

    // Without token → 401
    syncCalled = false;
    const res401 = await fetch(`http://127.0.0.1:${port}/forceSync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: "myaccount" }),
    });
    assert.equal(res401.status, 401);
    assert.equal(syncCalled, false);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Test 8: GET /healthz — unauthenticated, returns status JSON
// ---------------------------------------------------------------------------

test("GET /healthz: unauthenticated, returns 200 with deps.status() JSON", async () => {
  const deps = makeDeps({
    status: () => ({ wsUp: true, selfWxid: "wxid_healthz", lastMsgTs: 999 }),
  });

  const server = createBridgeServer(deps);
  const port = await server.listen(0);

  try {
    // No token needed
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { wsUp: true, selfWxid: "wxid_healthz", lastMsgTs: 999 });
  } finally {
    await server.close();
  }
});
