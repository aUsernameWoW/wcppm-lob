import { test } from "node:test";
import assert from "node:assert/strict";

import { createSendHandler, createMediaFetcher } from "./wiring.js";

test("createSendHandler: no replyTo → routes to sendText", async () => {
  const calls: unknown[][] = [];
  const client = {
    async sendText(to: string, text: string) {
      calls.push(["text", to, text]);
      return true;
    },
    async sendQuote(to: string, text: string, refer: string) {
      calls.push(["quote", to, text, refer]);
      return true;
    },
  };

  const send = createSendHandler(client);
  const r = await send({ to: "wxid_x", text: "hi" });

  assert.deepEqual(calls, [["text", "wxid_x", "hi"]]);
  assert.equal(r.ok, true);
});

test("createSendHandler: replyTo → routes to sendQuote with the refer id", async () => {
  const calls: unknown[][] = [];
  const client = {
    async sendText(to: string, text: string) {
      calls.push(["text", to, text]);
      return true;
    },
    async sendQuote(to: string, text: string, refer: string) {
      calls.push(["quote", to, text, refer]);
      return true;
    },
  };

  const send = createSendHandler(client);
  const r = await send({ to: "g@chatroom", text: "re", replyTo: "msg-99" });

  assert.deepEqual(calls, [["quote", "g@chatroom", "re", "msg-99"]]);
  assert.equal(r.ok, true);
});

test("createSendHandler: a false return from the client surfaces as ok:false", async () => {
  const client = {
    async sendText() {
      return false;
    },
    async sendQuote() {
      return false;
    },
  };

  const send = createSendHandler(client);
  assert.equal((await send({ to: "x", text: "y" })).ok, false);
});

test("createMediaFetcher: looks up the descriptor, downloads, returns the local path", async () => {
  let resolvedWith: any;
  let materializeDir: string | undefined;
  const client = {
    resolveMedia(message: any) {
      resolvedWith = message;
      return {
        kind: "image" as const,
        materialize: async (dir?: string) => {
          materializeDir = dir;
          return { filePath: "/media/wechat-image-img-9.jpg", mimeType: "image/jpeg", fileName: "wechat-image-img-9.jpg" };
        },
      };
    },
  };
  const store = {
    getMedia(account: string, id: string) {
      assert.equal(account, "default");
      assert.equal(id, "img-9");
      return { kind: "image", descriptor: JSON.stringify({ msgId: "img-9", msgType: 3, fromUser: "wxid_p", content: "<img/>" }) };
    },
  };

  const fetchMedia = createMediaFetcher(client, store, { dir: "/media" });
  const r = await fetchMedia("default", "img-9");

  assert.deepEqual(r, {
    ok: true,
    localPath: "/media/wechat-image-img-9.jpg",
    mimeType: "image/jpeg",
    fileName: "wechat-image-img-9.jpg",
  });
  assert.equal(materializeDir, "/media");
  assert.equal(resolvedWith.msgId, "img-9"); // reconstructed message passed to the client
});

test("createMediaFetcher: unknown id (pruned/missing descriptor) → ok:false, no download", async () => {
  let resolveCalled = false;
  const client = { resolveMedia: () => { resolveCalled = true; return null; } };
  const store = { getMedia: () => undefined };

  const fetchMedia = createMediaFetcher(client, store);
  assert.deepEqual(await fetchMedia("default", "gone"), { ok: false });
  assert.equal(resolveCalled, false);
});

test("createMediaFetcher: a download error degrades to ok:false (text still flows)", async () => {
  const client = {
    resolveMedia: () => ({
      kind: "image" as const,
      materialize: async () => { throw new Error("CDN 500"); },
    }),
  };
  const store = { getMedia: () => ({ kind: "image", descriptor: "{}" }) };

  const fetchMedia = createMediaFetcher(client, store);
  assert.deepEqual(await fetchMedia("default", "img-x"), { ok: false });
});
