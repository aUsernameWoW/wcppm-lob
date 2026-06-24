import { test } from "node:test";
import assert from "node:assert/strict";

import { listAccountIds, resolveAccount, isConfigured } from "./account-config.js";

const base = {
  bridgeUrl: "ws://127.0.0.1:8077",
  bridgeToken: "tok",
  dmSecurity: "allowlist",
  allowFrom: ["wxid_base"],
  groupAllowFrom: [],
};

test("listAccountIds: no channel section → []", () => {
  assert.deepEqual(listAccountIds({ channels: {} }), []);
  assert.deepEqual(listAccountIds({}), []);
});

test("listAccountIds: a flat section (no accounts map) → the single default account", () => {
  assert.deepEqual(listAccountIds({ channels: { wechatpadpro: base } }), ["default"]);
});

test("listAccountIds: an accounts map → its keys", () => {
  const cfg = {
    channels: { wechatpadpro: { ...base, accounts: { acctA: { account: "acctA" }, acctB: { account: "acctB" } } } },
  };
  assert.deepEqual(listAccountIds(cfg), ["acctA", "acctB"]);
});

test("resolveAccount: flat section resolves the default account (account defaults to id)", () => {
  const acc = resolveAccount({ channels: { wechatpadpro: base } }, "default");
  assert.equal(acc.accountId, "default");
  assert.equal(acc.account, "default");
  assert.equal(acc.bridgeUrl, "ws://127.0.0.1:8077");
  assert.equal(acc.dmPolicy, "allowlist");
  assert.deepEqual(acc.allowFrom, ["wxid_base"]);
});

test("resolveAccount: per-account entry overrides the base section; account defaults to the accountId", () => {
  const cfg = {
    channels: {
      wechatpadpro: {
        ...base,
        accounts: {
          acctA: { allowFrom: ["wxid_a"], dmSecurity: "pairing" },
          acctB: { account: "mw-b", bridgeToken: "tokB" },
        },
      },
    },
  };

  const a = resolveAccount(cfg, "acctA");
  assert.equal(a.account, "acctA"); // convention: middleware account == accountId
  assert.equal(a.bridgeUrl, "ws://127.0.0.1:8077"); // inherited from base
  assert.equal(a.bridgeToken, "tok"); // inherited
  assert.equal(a.dmPolicy, "pairing"); // overridden
  assert.deepEqual(a.allowFrom, ["wxid_a"]); // overridden

  const b = resolveAccount(cfg, "acctB");
  assert.equal(b.account, "mw-b"); // explicit override of the subscribe account
  assert.equal(b.bridgeToken, "tokB"); // overridden
  assert.deepEqual(b.allowFrom, ["wxid_base"]); // inherited (not overridden)
});

test("isConfigured: needs both bridgeUrl and bridgeToken", () => {
  assert.equal(isConfigured(resolveAccount({ channels: { wechatpadpro: base } }, "default")), true);
  assert.equal(
    isConfigured(resolveAccount({ channels: { wechatpadpro: { bridgeUrl: "ws://x" } } }, "default")),
    false,
  );
  assert.equal(isConfigured(undefined), false);
});
