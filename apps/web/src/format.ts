/** Number formatting helpers for the side panel. */
import type { Vec3 } from 'polymerge-core';

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

/** Compact number: 4 significant digits, exponent for very small / large magnitudes. */
export function fmtNum(x: number, digits = 4): string {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e6 || a < 1e-3) return x.toExponential(digits - 1);
  return String(Number(x.toPrecision(digits)));
}

export function fmtVec(v: ArrayLike<number> | null | undefined, digits = 4): string {
  if (!v) return '—';
  return `(${Array.from(v, (c) => fmtNum(c, digits)).join(', ')})`;
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function vecLength(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}
