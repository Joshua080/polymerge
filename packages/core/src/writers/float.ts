/** Number formatting shared by the text writers. */

/**
 * Shortest decimal representation that round-trips through float32.
 *
 * Every p-digit decimal is also a (p+1)-digit one, so the nearest (p+1)-digit decimal is never
 * farther from x than the nearest p-digit one: once p digits read back to the same float32, so
 * do more. That makes "does p round-trip" monotone in p (9 digits always do, for float32), so
 * the shortest is found by trying 8 and 7 first, then a binary search below — a few tries instead
 * of up to nine, which matters when a writer formats millions of coordinates.
 */
export function formatFloat32(x: number): string {
  const f = Math.fround(x);
  if (f === 0) return '0';
  if (!Number.isFinite(f)) throw new RangeError(`cannot write non-finite coordinate ${x}`);
  // Integers below 2^24 are exact in float32 and no shorter decimal reads back to them.
  if (Number.isInteger(f) && f > -16777216 && f < 16777216) return String(f);
  // Measured coordinates (scans, tessellations) mostly need 7–9 digits: try 8, then 7, before
  // searching the short end.
  const s8 = f.toPrecision(8);
  if (Math.fround(Number(s8)) !== f) return String(Number(f.toPrecision(9)));
  const s7 = f.toPrecision(7);
  if (Math.fround(Number(s7)) !== f) return String(Number(s8));
  let lo = 1;
  let hi = 7;
  let best = s7;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const s = f.toPrecision(mid);
    if (Math.fround(Number(s)) === f) {
      hi = mid;
      best = s;
    } else lo = mid + 1;
  }
  return String(Number(best));
}
