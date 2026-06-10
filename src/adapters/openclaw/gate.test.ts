import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateInboundFrame } from "./gate.js";
import type { Frame } from "../../shared/frame.js";

function makeFrame(overrides: Partial<Frame> = {}): Frame {
  return {
    type: "message",
    id: "m1",
    account: "default",
    chatType: "direct",
    from: { wxid: "wxid_peer" },
    chat: { id: "wxid_peer" },
    text: "hi",
    mentionedMe: false,
    ts: 1750000000,
    ...overrides,
  };
}

test("DM frames dispatch regardless of groupAllowFrom", () => {
  const verdict = evaluateInboundFrame(makeFrame(), {
    selfWxid: "wxid_self",
    groupAllowFrom: [],
  });
  assert.deepEqual(verdict, { action: "dispatch" });
});

test("group frame from a non-allowlisted group is dropped", () => {
  const frame = makeFrame({
    chatType: "group",
    chat: { id: "123@chatroom" },
    from: { wxid: "wxid_member" },
  });
  const verdict = evaluateInboundFrame(frame, {
    selfWxid: "wxid_self",
    groupAllowFrom: [],
  });
  assert.deepEqual(verdict, { action: "drop", reason: "group-not-allowed" });
});

test("group frame from an allowlisted group dispatches", () => {
  const frame = makeFrame({
    chatType: "group",
    chat: { id: "123@chatroom" },
    from: { wxid: "wxid_member" },
  });
  const verdict = evaluateInboundFrame(frame, {
    selfWxid: "wxid_self",
    groupAllowFrom: ["123@chatroom"],
  });
  assert.deepEqual(verdict, { action: "dispatch" });
});

test("'*' wildcard allows any group", () => {
  const frame = makeFrame({
    chatType: "group",
    chat: { id: "999@chatroom" },
    from: { wxid: "wxid_member" },
  });
  const verdict = evaluateInboundFrame(frame, {
    selfWxid: "wxid_self",
    groupAllowFrom: ["*"],
  });
  assert.deepEqual(verdict, { action: "dispatch" });
});

test("own echoed group message is dropped even in an allowlisted group", () => {
  const frame = makeFrame({
    chatType: "group",
    chat: { id: "123@chatroom" },
    from: { wxid: "wxid_self" },
  });
  const verdict = evaluateInboundFrame(frame, {
    selfWxid: "wxid_self",
    groupAllowFrom: ["123@chatroom"],
  });
  assert.deepEqual(verdict, { action: "drop", reason: "self-echo" });
});

test("own echoed DM is dropped (belt-and-suspenders; middleware already drops these)", () => {
  const frame = makeFrame({ from: { wxid: "wxid_self" } });
  const verdict = evaluateInboundFrame(frame, {
    selfWxid: "wxid_self",
    groupAllowFrom: [],
  });
  assert.deepEqual(verdict, { action: "drop", reason: "self-echo" });
});

test("unknown selfWxid disables the self-echo check, not the group gate", () => {
  const echoLike = makeFrame({
    chatType: "group",
    chat: { id: "123@chatroom" },
    from: { wxid: "wxid_self" },
  });
  assert.deepEqual(
    evaluateInboundFrame(echoLike, { selfWxid: null, groupAllowFrom: ["123@chatroom"] }),
    { action: "dispatch" },
  );
  assert.deepEqual(
    evaluateInboundFrame(echoLike, { selfWxid: "", groupAllowFrom: [] }),
    { action: "drop", reason: "group-not-allowed" },
  );
});
