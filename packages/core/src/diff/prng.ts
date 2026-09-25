/**
 * Deterministic pseudo-random helpers. The engine never calls Math.random: the same
 * inputs must always produce a bit-identical diff.
 */

/** mulberry32: tiny, fast, well-distributed 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `k` distinct indices drawn uniformly from [0, n) with a seeded partial Fisher–Yates
 * shuffle, returned in ascending order (better memory locality for later lookups).
 * If k ≥ n every index is returned.
 */
export function sampleIndices(n: number, k: number, seed: number): Uint32Array {
  if (k >= n) {
    const all = new Uint32Array(n);
    for (let i = 0; i < n; i++) all[i] = i;
    return all;
  }
  const rand = mulberry32(seed);
  const pool = new Uint32Array(n);
  for (let i = 0; i < n; i++) pool[i] = i;
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (n - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, k).sort();
}
