import { test } from "node:test";
import assert from "node:assert/strict";

import type { Frame } from "../shared/frame.js";
import { initState, applyFrame, applyStatus, setFilter, setInput, setOverlay } from "./state.js";
import { render } from "./render.js";

function frame(over: Partial<Frame> = {}): Frame {
  return {
    type: "message", id: Math.random().toString(36).slice(2), account: "default",
    chatType: "group", from: { wxid: "wxid_z", name: "张三" }, chat: { id: "g1", name: "产品讨论" },
    text: "需求评审", mentionedMe: false, ts: 100, ...over,
  };
}

test("render: returns exactly `rows` lines", () => {
  const s = initState(10);
  const lines = render(s, { rows: 12, cols: 80 });
  assert.equal(lines.length, 12);
});

test("render: header shows WS state and self wxid", () => {
  let s = initState(10);
  s = applyStatus(s, { wsUp: true, selfWxid: "wxid_self" });
  const lines = render(s, { rows: 12, cols: 80 });
  assert.match(lines[0], /WS up/);
  assert.match(lines[0], /wxid_self/);
});

test("render: shows visible messages and hides filtered-out ones", () => {
  let s = initState(10);
  s = applyFrame(s, frame({ text: "需求评审" }));
  s = applyFrame(s, frame({ text: "灌水", chat: { id: "g2", name: "灌水群" } }));
  s = setFilter(s, { keyword: "需求" });
  const body = render(s, { rows: 12, cols: 80 }).join("\n");
  assert.match(body, /需求评审/);
  assert.doesNotMatch(body, /灌水/);
});

test("render: overlay replaces the live window", () => {
  let s = initState(10);
  s = applyFrame(s, frame({ text: "需求评审" }));
  s = setOverlay(s, ["李四 · wxid_li"]);
  const body = render(s, { rows: 12, cols: 80 }).join("\n");
  assert.match(body, /李四 · wxid_li/);
  assert.doesNotMatch(body, /需求评审/);
});

test("render: input line carries the prompt and current input", () => {
  let s = initState(10);
  s = setInput(s, "send wxid_li 收到");
  const lines = render(s, { rows: 12, cols: 80 });
  assert.match(lines[lines.length - 1], /^: send wxid_li 收到/);
});

test("render: degrades gracefully on a tiny terminal", () => {
  const s = initState(10);
  const lines = render(s, { rows: 2, cols: 20 });
  assert.equal(lines.length, 2);
});
