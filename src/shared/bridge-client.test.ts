import { test } from "node:test";
import assert from "node:assert/strict";

import { createBridgeServer, type ServerDeps } from "../core/server.js";
import type { Frame } from "./frame.js";
import { createBridgeClient } from "./bridge-client.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fakeDeps(over: Partial<ServerDeps> = {}): ServerDeps {
  return {
    token: "tok",
    db: { getUndelivered: () => [], markDelivered: () => {} },
    send: async () => ({ ok: true }),
    forceSync: async () => ({ ok: true }),
    status: () => ({ wsUp: true }),
    selfWxid: () => "wxid_self",
    ...over,
  };
}

const sampleFrame: Frame = {
  type: "message",
  id: "m1",
  account: "default",
  chatType: "direct",
  from: { wxid: "wxid_a" },
  chat: { id: "wxid_a" },
  text: "hi",
  mentionedMe: false,
  ts: 1,
};

test("bridge-client: receives a broadcast frame via onMessage and auto-acks it", async () => {
  const marked: string[] = [];
  const server = createBridgeServer(fakeDeps({ db: { getUndelivered: () => [], markDelivered: (id) => marked.push(id) } }));
  const port = await server.listen(0);

  const got = deferred<Frame>();
  const client = createBridgeClient({ url: `ws://127.0.0.1:${port}`, token: "tok", onMessage: (f) => got.resolve(f) });
  client.connect();

  await waitFor(() => server.subscriberCount() === 1);
  server.broadcast(sampleFrame);

  const received = await got.promise;
  assert.equal(received.id, "m1");
  await waitFor(() => marked.includes("m1")); // auto-ack reached the server
  assert.deepEqual(marked, ["m1"]);

  client.close();
  await server.close();
});

test("bridge-client: onReady fires with selfWxid on connect", async () => {
  const server = createBridgeServer(fakeDeps({ selfWxid: () => "wxid_bot" }));
  const port = await server.listen(0);

  const ready = deferred<string>();
  const client = createBridgeClient({
    url: `ws://127.0.0.1:${port}`,
    token: "tok",
    onMessage: () => {},
    onReady: (self) => ready.resolve(self),
  });
  client.connect();

  assert.equal(await ready.promise, "wxid_bot");
  client.close();
  await server.close();
});

test("bridge-client.send: POSTs to /send with the bearer token and returns the result", async () => {
  let received: unknown;
  const server = createBridgeServer(
    fakeDeps({
      send: async (req) => {
        received = req;
        return { ok: true, msgId: "sent-1" };
      },
    }),
  );
  const port = await server.listen(0);

  const client = createBridgeClient({ url: `ws://127.0.0.1:${port}`, token: "tok", onMessage: () => {} });
  const r = await client.send({ to: "wxid_x", text: "hello", replyTo: "m9" });

  assert.deepEqual(received, { to: "wxid_x", text: "hello", replyTo: "m9" });
  assert.deepEqual(r, { ok: true, msgId: "sent-1" });

  await server.close();
});

test("bridge-client.send: a wrong token yields ok:false (server 401)", async () => {
  const server = createBridgeServer(fakeDeps());
  const port = await server.listen(0);

  const client = createBridgeClient({ url: `ws://127.0.0.1:${port}`, token: "WRONG", onMessage: () => {} });
  const r = await client.send({ to: "x", text: "y" });
  assert.equal(r.ok, false);

  await server.close();
});

test("getContacts/getHistory/getHealth hit the read-only endpoints", async () => {
  const frame = { type: "message", id: "h1", account: "default", chatType: "direct",
    from: { wxid: "wxid_li" }, chat: { id: "wxid_li" }, text: "hi", mentionedMe: false, ts: 10 };
  const server = createBridgeServer({
    token: "tkn",
    db: { getUndelivered: () => [], markDelivered: () => {} },
    send: async () => ({ ok: true }),
    forceSync: async () => ({ ok: true }),
    status: () => ({ wsUp: true, selfWxid: "wxid_self", lastMsgTs: 42 }),
    selfWxid: () => "wxid_self",
    queryContacts: () => [{ wxid: "wxid_li", name: "李四", type: "friend", updatedAt: 1 }],
    queryHistory: () => [frame as unknown as Frame],
  });
  const port = await server.listen(0);
  const client = createBridgeClient({ url: `ws://127.0.0.1:${port}`, token: "tkn", onMessage: () => {} });
  try {
    assert.deepEqual(await client.getContacts("li"), [
      { wxid: "wxid_li", name: "李四", type: "friend", updatedAt: 1 },
    ]);
    assert.deepEqual(await client.getHistory({ chat: "wxid_li", limit: 5 }), [frame]);
    const health = await client.getHealth();
    assert.equal(health.wsUp, true);
    assert.equal(health.selfWxid, "wxid_self");
  } finally {
    client.close();
    await server.close();
  }
});
