import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProxyTransport } from "./proxy.js";

test("empty string proxy → direct, no ws agent", () => {
  const t = buildProxyTransport("");
  assert.equal(t.kind, "direct");
  assert.ok(t.dispatcher, "direct mode still needs a dispatcher to bypass the global env proxy");
  assert.equal(t.wsAgent, undefined);
});

test("undefined proxy → direct", () => {
  assert.equal(buildProxyTransport(undefined).kind, "direct");
});

test("whitespace-only proxy → direct", () => {
  assert.equal(buildProxyTransport("   ").kind, "direct");
});

test("http:// proxy → http mode with a ws agent", () => {
  const t = buildProxyTransport("http://127.0.0.1:8889");
  assert.equal(t.kind, "http");
  assert.ok(t.dispatcher);
  assert.ok(t.wsAgent, "proxied mode must supply a ws agent");
});

test("https:// proxy → http mode", () => {
  assert.equal(buildProxyTransport("https://proxy.example:443").kind, "http");
});

test("socks5:// proxy (with creds) → socks mode with a ws agent", () => {
  const t = buildProxyTransport("socks5://user:pass@127.0.0.1:1080");
  assert.equal(t.kind, "socks");
  assert.ok(t.dispatcher);
  assert.ok(t.wsAgent);
});

test("socks5h:// scheme → socks mode", () => {
  assert.equal(buildProxyTransport("socks5h://127.0.0.1:1080").kind, "socks");
});

test("socks4:// scheme → socks mode", () => {
  assert.equal(buildProxyTransport("socks4://127.0.0.1:1080").kind, "socks");
});

test("unsupported scheme → throws a helpful error naming the scheme", () => {
  assert.throws(() => buildProxyTransport("ftp://nope:21"), /unsupported proxy scheme/i);
});

test("malformed URL → throws a helpful invalid-Proxy-URL error", () => {
  assert.throws(() => buildProxyTransport("not a url"), /invalid Proxy URL/i);
});
