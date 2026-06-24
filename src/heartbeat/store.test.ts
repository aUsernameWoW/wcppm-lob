import { test } from "node:test";
import assert from "node:assert/strict";
import { RedisHeartbeatStore, netKey, type RedisLike } from "./store.js";
import { freshNetInfo } from "./types.js";
import { heartbeatNetDetail } from "./runtime.js";

function fakeRedis(): RedisLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) { return data.has(k) ? data.get(k)! : null; },
    async set(k, v) { data.set(k, v); return "OK"; },
    async quit() { return "OK"; },
  };
}

test("netKey is namespaced by prefix, authcode, netDetail", () => {
  assert.equal(netKey("hbconductor:", "AC1", "egress:direct"), "hbconductor:AC1:egress:direct");
});

test("heartbeatNetDetail: includes host:port so a shared authcode still yields distinct keys", () => {
  const a = heartbeatNetDetail({ host: "127.0.0.1", port: 8062 });
  const b = heartbeatNetDetail({ host: "127.0.0.1", port: 8063 });
  assert.equal(a, "egress:direct@127.0.0.1:8062");
  assert.notEqual(a, b); // same authcode + same host, different port → different netKey

  // Two instances sharing an authcode no longer collide in redis.
  assert.notEqual(netKey("hbconductor:", "SHARED", a), netKey("hbconductor:", "SHARED", b));

  assert.equal(heartbeatNetDetail({ host: "h", port: 9, proxy: "http://p" }), "egress:proxy@h:9");
});

test("save then load round-trips NetHeartbeatInfo", async () => {
  const r = fakeRedis();
  const store = new RedisHeartbeatStore({ url: "redis://x", db: 15 }, r);
  const info = freshNetInfo("egress:direct");
  info.curHeart = 330000; info.isStable = true; info.succHeartCount = 4;
  await store.save("AC1", info);
  const got = await store.load("AC1", "egress:direct");
  assert.deepEqual(got, info);
});

test("load returns null for an unknown network", async () => {
  const r = fakeRedis();
  const store = new RedisHeartbeatStore({ url: "redis://x", db: 15 }, r);
  assert.equal(await store.load("AC1", "nope"), null);
});
