import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHeartbeat, WcppHeartbeatClient } from "./wcpp-client.js";

function silentLog() { return { info() {}, error() {}, warn() {}, debug() {} }; }

test("classifyHeartbeat: Success+ret0 → success, surfaces Selector (log-only)", () => {
  const r = classifyHeartbeat({ Success: true, Data: { BaseResponse: { ret: 0 }, NextTime: 149, Selector: 4294967295 } });
  assert.deepEqual(r, { success: true, failOfTimeout: false, selector: 4294967295 });
});

test("classifyHeartbeat: non-zero ret → failure (not timeout)", () => {
  const r = classifyHeartbeat({ Success: true, Data: { BaseResponse: { ret: -1 } } });
  assert.deepEqual(r, { success: false, failOfTimeout: false });
});

test("classifyHeartbeat: malformed body → failure", () => {
  assert.deepEqual(classifyHeartbeat({}), { success: false, failOfTimeout: false });
});

test("sendHeartbeat posts to the right URL and classifies", async () => {
  let calledUrl = "";
  const fetchImpl = (async (url: any, _init: any) => {
    calledUrl = String(url);
    return { ok: true, async json() { return { Success: true, Data: { BaseResponse: { ret: 0 } } }; } } as any;
  }) as typeof fetch;
  const c = new WcppHeartbeatClient({
    baseUrl: "http://192.168.5.24:8062", authcode: "AC", log: silentLog(), fetchImpl,
  });
  const r = await c.sendHeartbeat();
  assert.equal(r.success, true);
  assert.match(calledUrl, /\/api\/Login\/HeartBeat\?authcode=AC$/);
});

test("sendHeartbeat maps a timeout/abort to failOfTimeout", async () => {
  const fetchImpl = (async () => { const e: any = new Error("aborted"); e.name = "AbortError"; throw e; }) as typeof fetch;
  const c = new WcppHeartbeatClient({ baseUrl: "http://x", authcode: "AC", log: silentLog(), fetchImpl, timeoutMs: 5 });
  const r = await c.sendHeartbeat();
  assert.equal(r.success, false);
  assert.equal(r.failOfTimeout, true);
  assert.equal(typeof r.latencyMs, "number");
});
