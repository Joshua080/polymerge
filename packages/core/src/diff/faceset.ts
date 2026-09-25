/**
 * Exact hash set of triangles compared as UNORDERED vertex triples.
 *
 * Open addressing (linear probing) over a power-of-two table; each slot stores the
 * sorted triple (a < b < c) with `a + 1` in the first word so that 0 marks an empty
 * slot. No string keys and no BigInt: 200k faces build in a few milliseconds and
 * lookups are allocation-free.
 */
export class FaceSet {
  /** Number of distinct triples stored. */
  readonly size: number;
  private readonly keys: Uint32Array;
  private readonly mask: number;

  constructor(faces: Uint32Array) {
    const n = Math.floor(faces.length / 3);
    let cap = 16;
    while (cap < n * 2) cap *= 2;
    this.keys = new Uint32Array(cap * 3);
    this.mask = cap - 1;
    let size = 0;
    for (let f = 0; f < n; f++) {
      if (this.insert(faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2])) size++;
    }
    this.size = size;
  }

  /** True if the unordered triple {a, b, c} is a face of the mesh. */
  has(a: number, b: number, c: number): boolean {
    // Sort the triple.
    let t: number;
    if (a > b) {
      t = a;
      a = b;
      b = t;
    }
    if (b > c) {
      t = b;
      b = c;
      c = t;
    }
    if (a > b) {
      t = a;
      a = b;
      b = t;
    }
    const keys = this.keys;
    const a1 = (a + 1) >>> 0;
    let slot = hash3(a, b, c) & this.mask;
    for (;;) {
      const o = slot * 3;
      const k0 = keys[o];
      if (k0 === 0) return false;
      if (k0 === a1 && keys[o + 1] === b && keys[o + 2] === c) return true;
      slot = (slot + 1) & this.mask;
    }
  }

  private insert(a: number, b: number, c: number): boolean {
    let t: number;
    if (a > b) {
      t = a;
      a = b;
      b = t;
    }
    if (b > c) {
      t = b;
      b = c;
      c = t;
    }
    if (a > b) {
      t = a;
      a = b;
      b = t;
    }
    const keys = this.keys;
    const a1 = (a + 1) >>> 0;
    let slot = hash3(a, b, c) & this.mask;
    for (;;) {
      const o = slot * 3;
      const k0 = keys[o];
      if (k0 === 0) {
        keys[o] = a1;
        keys[o + 1] = b;
        keys[o + 2] = c;
        return true;
      }
      if (k0 === a1 && keys[o + 1] === b && keys[o + 2] === c) return false;
      slot = (slot + 1) & this.mask;
    }
  }
}

/** 32-bit hash of a sorted index triple (murmur3-style finaliser). */
export function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x2545f491, 0x9e3779b1);
  h = Math.imul(h ^ b ^ (h >>> 15), 0x85ebca77);
  h = Math.imul(h ^ c ^ (h >>> 13), 0xc2b2ae3d);
  h ^= h >>> 16;
  return h >>> 0;
}
