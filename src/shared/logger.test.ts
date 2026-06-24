import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./logger.js";

/** Capture everything written to the console during `fn`, joined per-call. */
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  const rec = (...a: any[]) => { lines.push(a.join(" ")); };
  console.log = rec; console.warn = rec; console.error = rec; console.debug = rec;
  try { fn(); } finally { Object.assign(console, orig); }
  return lines;
}

test("level label is padded to 5 chars and precedes the message", () => {
  const log = createLogger({ color: false });
  // ["INFO ", "hello"] joined by a space → "INFO " + " " + "hello".
  assert.equal(capture(() => log.info("hello"))[0], "INFO  hello");
  assert.equal(capture(() => log.warn("x"))[0], "WARN  x");
  assert.equal(capture(() => log.error("x"))[0], "ERROR x");
});

test("child appends bracketed tags in order", () => {
  const log = createLogger({ color: false }).child("acctA");
  assert.equal(capture(() => log.warn("[hb] beat"))[0], "WARN  [acctA] [hb] beat");
  const nested = log.child("net");
  assert.equal(capture(() => nested.info("up"))[0], "INFO  [acctA] [net] up");
});

test("debug output is gated by opts.debug", () => {
  assert.equal(capture(() => createLogger({ color: false, debug: false }).debug("x")).length, 0);
  assert.equal(capture(() => createLogger({ color: false, debug: true }).debug("x")).length, 1);
});

test("no ANSI escape codes when color:false", () => {
  const line = capture(() => createLogger({ color: false }).error("boom"))[0];
  assert.ok(!line.includes("\x1b"), `expected no escape codes, got: ${JSON.stringify(line)}`);
});

test("color:true wraps the level token in ANSI", () => {
  const line = capture(() => createLogger({ color: true }).info("hi"))[0];
  assert.ok(line.includes("\x1b["), "expected an ANSI escape sequence around the level");
});
