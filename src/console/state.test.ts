import { test } from "node:test";
import assert from "node:assert/strict";

import type { Frame } from "../shared/frame.js";
import {
  initState, applyFrame, applyStatus, setFilter, clearFilter,
  scroll, setInput, setStatusLine, setOverlay, clearOverlay, visibleMessages,
} from "./state.js";

function frame(over: Partial<Frame> = {}): Frame {
  return {
    type: "message", id: Math.random().toString(36).slice(2), account: "default",
    chatType: "group", from: { wxid: "wxid_z", name: "张三" }, chat: { id: "g1", name: "产品讨论" },
    text: "hello", mentionedMe: false, ts: 100, ...over,
  };
}

test("applyFrame: appends, counts, caps at the ring size", () => {
  let s = initState(3);
  for (let i = 0; i < 5; i++) s = applyFrame(s, frame({ text: `m${i}` }));
  assert.equal(s.messages.length, 3);
  assert.deepEqual(s.messages.map((m) => m.text), ["m2", "m3", "m4"]); // oldest dropped
  assert.equal(s.recvCount, 5);
});

test("visibleMessages: filter by chat, keyword, and dm-only", () => {
  let s = initState(10);
  s = applyFrame(s, frame({ text: "需求评审", chat: { id: "g1", name: "产品讨论" } }));
  s = applyFrame(s, frame({ text: "闲聊", chat: { id: "g2", name: "灌水群" } }));
  s = applyFrame(s, frame({ text: "在吗", chatType: "direct", chat: { id: "wxid_li", name: "李四" } }));

  assert.equal(visibleMessages(setFilter(s, { chat: "产品" })).length, 1);
  assert.equal(visibleMessages(setFilter(s, { keyword: "需求" })).length, 1);
  assert.equal(visibleMessages(setFilter(s, { dmOnly: true })).length, 1);
  assert.equal(visibleMessages(clearFilter(s)).length, 3);
});

test("scroll: clamps to [0, len-1] and toggles follow", () => {
  let s = initState(10);
  for (let i = 0; i < 4; i++) s = applyFrame(s, frame());
  s = scroll(s, 2);
  assert.equal(s.scrollOffset, 2);
  assert.equal(s.follow, false);
  s = scroll(s, 99); // clamp
  assert.equal(s.scrollOffset, 3);
  s = scroll(s, -99); // back to bottom → follow
  assert.equal(s.scrollOffset, 0);
  assert.equal(s.follow, true);
});

test("input, statusLine, overlay reducers", () => {
  let s = initState(10);
  s = setInput(s, "send x hi");
  assert.equal(s.input, "send x hi");
  s = setStatusLine(s, "✓ sent");
  assert.equal(s.statusLine, "✓ sent");
  s = setOverlay(s, ["line a", "line b"]);
  assert.deepEqual(s.overlay, ["line a", "line b"]);
  s = clearOverlay(s);
  assert.equal(s.overlay, undefined);
});
