/**
 * Binary min-heap of (cost, a, b) triples backed by growable typed arrays.
 *
 * Ordering is lexicographic on (cost, a, b), so ties are broken by index and the pop
 * order is fully deterministic regardless of push order of equal-cost entries.
 */
export class PairHeap {
  private cost: Float64Array;
  private a: Int32Array;
  private b: Int32Array;
  private n = 0;

  /** Filled by `pop()`. */
  topCost = 0;
  topA = -1;
  topB = -1;

  constructor(capacity = 1024) {
    const cap = Math.max(16, capacity | 0);
    this.cost = new Float64Array(cap);
    this.a = new Int32Array(cap);
    this.b = new Int32Array(cap);
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  push(cost: number, a: number, b: number): void {
    if (this.n === this.cost.length) this.grow();
    const C = this.cost;
    const A = this.a;
    const B = this.b;
    // Sift the hole up.
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const pc = C[p];
      if (pc < cost || (pc === cost && (A[p] < a || (A[p] === a && B[p] <= b)))) break;
      C[i] = pc;
      A[i] = A[p];
      B[i] = B[p];
      i = p;
    }
    C[i] = cost;
    A[i] = a;
    B[i] = b;
  }

  /** Removes the minimum into `topCost/topA/topB`. Returns false when empty. */
  pop(): boolean {
    if (this.n === 0) return false;
    const C = this.cost;
    const A = this.a;
    const B = this.b;
    this.topCost = C[0];
    this.topA = A[0];
    this.topB = B[0];
    const last = --this.n;
    if (last === 0) return true;
    const lc = C[last];
    const la = A[last];
    const lb = B[last];
    // Sift the hole down.
    let i = 0;
    const n = last;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      const r = c + 1;
      if (r < n && (C[r] < C[c] || (C[r] === C[c] && (A[r] < A[c] || (A[r] === A[c] && B[r] < B[c]))))) c = r;
      const cc = C[c];
      if (lc < cc || (lc === cc && (la < A[c] || (la === A[c] && lb <= B[c])))) break;
      C[i] = cc;
      A[i] = A[c];
      B[i] = B[c];
      i = c;
    }
    C[i] = lc;
    A[i] = la;
    B[i] = lb;
    return true;
  }

  private grow(): void {
    const cap = this.cost.length * 2;
    const c = new Float64Array(cap);
    c.set(this.cost);
    const a = new Int32Array(cap);
    a.set(this.a);
    const b = new Int32Array(cap);
    b.set(this.b);
    this.cost = c;
    this.a = a;
    this.b = b;
  }
}
