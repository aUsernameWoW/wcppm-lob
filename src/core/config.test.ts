import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "./config.js";

test("resolveConfig: a flat single-instance config becomes instances[0]=default and threads wcpp fields", () => {
  const cfg = resolveConfig({ host: "100.64.0.8", authcode: "AC", bridgeToken: "secret" });

  assert.equal(cfg.instances.length, 1);
  assert.equal(cfg.instances[0].account, "default");
  assert.equal(cfg.instances[0].wcpp.host, "100.64.0.8");
  assert.equal(cfg.instances[0].wcpp.port, 8062);
  assert.equal(cfg.instances[0].wcpp.authcode, "AC");

  // bridge defaults
  assert.equal(cfg.bridgeHost, "127.0.0.1");
  assert.equal(cfg.bridgePort, 8077);
  assert.equal(cfg.ageWindowSeconds, 600);
  assert.equal(cfg.bridgeToken, "secret");
});

test("resolveConfig: flat config respects an explicit account label", () => {
  const cfg = resolveConfig({ host: "h", port: 9001, bridgeToken: "t", account: "acct2" });
  assert.equal(cfg.instances.length, 1);
  assert.equal(cfg.instances[0].account, "acct2");
  assert.equal(cfg.instances[0].wcpp.port, 9001);
});

test("resolveConfig: an instances[] config yields one WcppConfig per entry, account-labelled", () => {
  const cfg = resolveConfig({
    bridgeToken: "t",
    instances: [
      { account: "acctA", host: "100.64.0.8", port: 8062, authcode: "A", wsUrl: "ws://100.64.0.8:8089/x", wxid: "wxid_a" },
      { account: "acctB", host: "100.64.0.8", port: 8063, authcode: "B", wsUrl: "ws://100.64.0.8:8090/x", wxid: "wxid_b" },
    ],
  });

  assert.equal(cfg.instances.length, 2);
  assert.deepEqual(cfg.instances.map((i) => i.account), ["acctA", "acctB"]);
  assert.equal(cfg.instances[0].wcpp.wsUrl, "ws://100.64.0.8:8089/x");
  assert.equal(cfg.instances[0].wcpp.wxid, "wxid_a");
  assert.equal(cfg.instances[1].wcpp.port, 8063);
  assert.equal(cfg.instances[1].wcpp.wxid, "wxid_b");
});

test("resolveConfig: duplicate account labels are rejected", () => {
  assert.throws(
    () =>
      resolveConfig({
        bridgeToken: "t",
        instances: [
          { account: "dup", host: "h", authcode: "A" },
          { account: "dup", host: "h", authcode: "B" },
        ],
      }),
    /duplicate account/i,
  );
});

test("resolveConfig: an instance missing an account label is rejected", () => {
  assert.throws(
    () => resolveConfig({ bridgeToken: "t", instances: [{ host: "h", authcode: "A" }] }),
    /account/i,
  );
});

test("resolveConfig: webhook listener config is shared (top-level) with defaults", () => {
  const cfg = resolveConfig({ host: "h", bridgeToken: "t" });
  assert.equal(cfg.webhook.enabled, false);
  assert.equal(cfg.webhook.host, "127.0.0.1");
  assert.equal(cfg.webhook.port, 8000);
  assert.equal(cfg.webhook.path, "/webhook");

  const cfg2 = resolveConfig({
    bridgeToken: "t",
    webhookEnabled: true,
    webhookPort: 9100,
    webhookSecret: "s",
    instances: [{ account: "a", host: "h", authcode: "A" }],
  });
  assert.equal(cfg2.webhook.enabled, true);
  assert.equal(cfg2.webhook.port, 9100);
  assert.equal(cfg2.webhook.secret, "s");
});

test("resolveConfig: per-instance webhook listeners are NOT started (shared listener owns the port)", () => {
  // The middleware runs ONE shared webhook listener and routes by Wxid; each
  // WcppClient must therefore keep its own in-client webhook server disabled.
  const cfg = resolveConfig({
    bridgeToken: "t",
    webhookEnabled: true,
    instances: [{ account: "a", host: "h", authcode: "A" }],
  });
  assert.notEqual(cfg.instances[0].wcpp.webhookEnabled, true);
});

test("resolveConfig: wsEnabled defaults true and can be disabled per instance", () => {
  const cfg = resolveConfig({
    bridgeToken: "t",
    instances: [
      { account: "a", host: "h", authcode: "A" },
      { account: "b", host: "h", authcode: "B", wsEnabled: false },
    ],
  });
  assert.equal(cfg.instances[0].wcpp.wsEnabled, true);
  assert.equal(cfg.instances[1].wcpp.wsEnabled, false);
});

test("resolveConfig: webhookRegister threads url + inherits the shared webhookSecret; defaults off", () => {
  const cfg = resolveConfig({
    bridgeToken: "t",
    webhookSecret: "shared-secret",
    instances: [
      { account: "a", host: "h", authcode: "A" },
      { account: "b", host: "h", authcode: "B", webhookRegister: true, webhookUrl: "https://pub/webhook" },
    ],
  });
  // default off, no url
  assert.equal(cfg.instances[0].wcpp.webhookRegister, false);
  // opted in: url threaded, secret inherited from the shared top-level webhookSecret
  assert.equal(cfg.instances[1].wcpp.webhookRegister, true);
  assert.equal(cfg.instances[1].wcpp.webhookUrl, "https://pub/webhook");
  assert.equal(cfg.instances[1].wcpp.webhookSecret, "shared-secret");
});

test("resolveConfig: webhookRegister:true without webhookUrl is rejected", () => {
  assert.throws(
    () =>
      resolveConfig({
        bridgeToken: "t",
        instances: [{ account: "a", host: "h", authcode: "A", webhookRegister: true }],
      }),
    /webhookRegister.*webhookUrl/i,
  );
});

test("resolveConfig: each instance inherits the global heartbeat config when it has no override", () => {
  const cfg = resolveConfig({
    bridgeToken: "t",
    heartbeat: { enabled: true, redisDb: 7, maxPerHour: 20 },
    instances: [
      { account: "a", host: "h", authcode: "A" },
      { account: "b", host: "h", port: 8063, authcode: "B" },
    ],
  });
  for (const inst of cfg.instances) {
    assert.equal(inst.heartbeat.enabled, true);
    assert.equal(inst.heartbeat.redisDb, 7);
    assert.equal(inst.heartbeat.maxPerHour, 20);
  }
  // The top-level heartbeat remains the global/base config.
  assert.equal(cfg.heartbeat.redisDb, 7);
});

test("resolveConfig: a per-instance heartbeat override merges over the global, others inherit", () => {
  const cfg = resolveConfig({
    bridgeToken: "t",
    heartbeat: { enabled: true, redisUrl: "redis://global:6379", redisDb: 0, maxPerHour: 30 },
    instances: [
      { account: "a", host: "h", authcode: "A" },
      { account: "b", host: "h", port: 8063, authcode: "B", heartbeat: { enabled: false, maxPerHour: 10 } },
    ],
  });

  const a = cfg.instances[0].heartbeat;
  const b = cfg.instances[1].heartbeat;

  assert.equal(a.enabled, true); // a uses the global
  assert.equal(b.enabled, false); // b overrides
  assert.equal(b.maxPerHour, 10); // b overrides
  assert.equal(b.redisUrl, "redis://global:6379"); // b inherits non-overridden fields
  assert.equal(b.redisDb, 0); // inherited
});

test("resolveConfig: a missing bridgeToken is rejected (it guards the downstream interface)", () => {
  assert.throws(() => resolveConfig({ host: "h" }), /bridgeToken/);
});

test("resolveConfig: an empty-string dbPath falls back to the default path", () => {
  const cfg = resolveConfig({ host: "h", bridgeToken: "t", dbPath: "" });
  assert.match(cfg.dbPath, /state\.db$/);
});
