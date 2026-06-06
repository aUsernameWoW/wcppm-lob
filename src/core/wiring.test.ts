import { test } from "node:test";
import assert from "node:assert/strict";

import { createSendHandler } from "./wiring.js";

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
