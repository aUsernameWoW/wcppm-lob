/**
 * rng.test.ts — TDD tests for the seeded RNG used by the image-download retry.
 *
 * Contract: makeRng(seed) returns a () => number in [0,1).
 *   - no seed → Math.random (unpredictable; we only assert the range + that it's
 *     NOT pinned to a seeded sequence).
 *   - a seed (number or string) → a deterministic PRNG: same seed reproduces the
 *     exact same sequence; different seeds diverge.
 *
 * The whole point of the config `randomSeed` is reproducibility, so that is what
 * these tests pin.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeRng } from "./rng.js";

const seq = (rng: () => number, n: number) => Array.from({ length: n }, () => rng());

test("makeRng: every draw is in [0,1)", () => {
  for (const seed of [undefined, 0, 42, "hello"] as const) {
    const rng = makeRng(seed);
    for (let i = 0; i < 100; i++) {
      const x = rng();
      assert.ok(x >= 0 && x < 1, `draw ${x} out of range for seed ${String(seed)}`);
    }
  }
});

test("makeRng: same numeric seed reproduces the same sequence", () => {
  const a = seq(makeRng(42), 10);
  const b = seq(makeRng(42), 10);
  assert.deepEqual(a, b);
});

test("makeRng: same string seed reproduces the same sequence", () => {
  const a = seq(makeRng("wcppm"), 10);
  const b = seq(makeRng("wcppm"), 10);
  assert.deepEqual(a, b);
});

test("makeRng: different seeds diverge", () => {
  const a = seq(makeRng(1), 10);
  const b = seq(makeRng(2), 10);
  assert.notDeepEqual(a, b);
  const c = seq(makeRng("alpha"), 10);
  const d = seq(makeRng("beta"), 10);
  assert.notDeepEqual(c, d);
});

test("makeRng: no seed is not pinned to the seeded sequence (uses Math.random)", () => {
  // Two unseeded generators producing identical 10-length sequences would imply
  // a fixed seed leaked in. Astronomically unlikely with Math.random.
  const a = seq(makeRng(), 10);
  const b = seq(makeRng(), 10);
  assert.notDeepEqual(a, b);
});
