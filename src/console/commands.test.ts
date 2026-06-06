import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCommand } from "./commands.js";

test("parseCommand: slash filters and toggles", () => {
  assert.deepEqual(parseCommand("/filter 产品讨论"), { kind: "filter", chat: "产品讨论" });
  assert.deepEqual(parseCommand("/grep 需求"), { kind: "grep", keyword: "需求" });
  assert.deepEqual(parseCommand("/dm"), { kind: "dm" });
  assert.deepEqual(parseCommand("/clear"), { kind: "clear" });
});

test("parseCommand: send needs a target and text", () => {
  assert.deepEqual(parseCommand("send wxid_li 收到 了"), { kind: "send", to: "wxid_li", text: "收到 了" });
  assert.equal(parseCommand("send wxid_li").kind, "error");
});

test("parseCommand: reply, forcesync, who, history, status, help, quit", () => {
  assert.deepEqual(parseCommand("r 收到"), { kind: "reply", text: "收到" });
  assert.deepEqual(parseCommand("forcesync"), { kind: "forcesync" });
  assert.deepEqual(parseCommand("who 李"), { kind: "who", query: "李" });
  assert.deepEqual(parseCommand("history wxid_li 10"), { kind: "history", chat: "wxid_li", limit: 10 });
  assert.deepEqual(parseCommand("history wxid_li"), { kind: "history", chat: "wxid_li", limit: 20 });
  assert.deepEqual(parseCommand("status"), { kind: "status" });
  assert.deepEqual(parseCommand("help"), { kind: "help" });
  assert.deepEqual(parseCommand("quit"), { kind: "quit" });
  assert.deepEqual(parseCommand("q"), { kind: "quit" });
});

test("parseCommand: unknown and empty are errors", () => {
  assert.equal(parseCommand("frobnicate x").kind, "error");
  assert.equal(parseCommand("   ").kind, "error");
});
