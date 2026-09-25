/**
 * Deterministic pseudo-randomness for fixture permutations.
 * mulberry32: tiny, fast, fully specified 32-bit PRNG — identical output on every
 * platform and Node version, so generated files are byte-stable.
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n). */
export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/** Fisher–Yates permutation of [0, n) — `perm[newPosition] = oldIndex`. */
export function permutation(n: number, seed: number): number[] {
  const rng = mulberry32(seed);
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  return p;
}

/** Deterministic per-element values in [0, k). */
export function randomInts(n: number, k: number, seed: number): number[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => randInt(rng, k));
}

/** Number of positions where `perm[i] !== i`. */
export function displacedCount(perm: readonly number[]): number {
  let c = 0;
  for (let i = 0; i < perm.length; i++) if (perm[i] !== i) c++;
  return c;
}
