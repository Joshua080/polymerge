/** Number formatting shared by the text writers. */

/** Shortest decimal representation that round-trips through float32. */
export function formatFloat32(x: number): string {
  const f = Math.fround(x);
  if (f === 0) return '0';
  if (!Number.isFinite(f)) throw new RangeError(`cannot write non-finite coordinate ${x}`);
  for (let p = 1; p <= 9; p++) {
    const s = f.toPrecision(p);
    if (Math.fround(Number(s)) === f) return String(Number(s));
  }
  return String(f);
}
