import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "./config.js";

test("resolveConfig: fills bridge defaults (port 8077, loopback, age window) and threads wcpp fields", () => {
  const cfg = resolveConfig({ host: "100.64.0.8", authcode: "AC", bridgeToken: "secret" });

  // wcpp passthrough + defaults
  assert.equal(cfg.wcpp.host, "100.64.0.8");
  assert.equal(cfg.wcpp.port, 8062);
  assert.equal(cfg.wcpp.authcode, "AC");

  // bridge defaults
  assert.equal(cfg.account, "default");
  assert.equal(cfg.bridgeHost, "127.0.0.1");
  assert.equal(cfg.bridgePort, 8077);
  assert.equal(cfg.ageWindowSeconds, 600);
  assert.equal(cfg.bridgeToken, "secret");
});

test("resolveConfig: explicit values override defaults", () => {
  const cfg = resolveConfig({
    host: "h",
    port: 9001,
    bridgeToken: "t",
    account: "acct2",
    bridgeHost: "0.0.0.0",
    bridgePort: 9999,
    ageWindowSeconds: 120,
    dbPath: "/tmp/x.db",
  });

  assert.equal(cfg.wcpp.port, 9001);
  assert.equal(cfg.account, "acct2");
  assert.equal(cfg.bridgeHost, "0.0.0.0");
  assert.equal(cfg.bridgePort, 9999);
  assert.equal(cfg.ageWindowSeconds, 120);
  assert.equal(cfg.dbPath, "/tmp/x.db");
});

test("resolveConfig: a missing bridgeToken is rejected (it guards the downstream interface)", () => {
  assert.throws(() => resolveConfig({ host: "h" }), /bridgeToken/);
});

test("resolveConfig: an empty-string dbPath falls back to the default path", () => {
  const cfg = resolveConfig({ host: "h", bridgeToken: "t", dbPath: "" });
  assert.match(cfg.dbPath, /state\.db$/);
});
