/**
 * rng.ts — a tiny seeded RNG, no third-party deps (project rule: core/ stays
 * dependency-light and uses node built-ins only).
 *
 * makeRng(seed) returns a () => number in [0,1):
 *   - seed undefined/null → Math.random (real entropy, NOT reproducible). This
 *     is what production should use: a fixed seed makes the retry cadence
 *     PREDICTABLE, which is the opposite of what we want against risk control.
 *   - seed given (number or string) → mulberry32, a deterministic PRNG. Same
 *     seed reproduces the exact same sequence — for debugging / reproducing a
 *     run, not for steady-state operation.
 */

/** xfnv1a: fold an arbitrary string into a 32-bit unsigned seed. */
function hashStringSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good-enough deterministic PRNG seeded by a uint32. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a [0,1) generator. With no seed it is just Math.random; with a seed
 * (number or string) it is a reproducible mulberry32 sequence.
 */
export function makeRng(seed?: number | string | null): () => number {
  if (seed === undefined || seed === null) return Math.random;
  const numericSeed = typeof seed === "number" ? seed >>> 0 : hashStringSeed(seed);
  return mulberry32(numericSeed);
}
