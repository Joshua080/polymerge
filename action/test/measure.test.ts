import { formatChange as coreChange, formatMeasure as coreMeasure, formatNumber as coreNumber } from 'polymerge-core';
import { describe, expect, it } from 'vitest';
import { formatChange, formatMeasure, formatNumber, formatSize } from '../lib/measure.mjs';

const VALUES = [0, 0.0004, 0.0123, 0.5, 1, 9.99, 12.345, 99.95, 512.5, 999.4, 1000, 1234.5, 9999, 10_000, 52_345.6, 2.5e6, 9.9e6, 1e7, 3.2e8, 9.99e8, 1e9, 4.2e12, -7.25];

describe('action/lib/measure.mjs agrees with polymerge-core', () => {
  it('formatNumber', () => {
    for (const v of VALUES) expect(formatNumber(v)).toBe(coreNumber(v));
  });

  it('formatMeasure, every dimension and unit', () => {
    for (const unit of ['mm', 'm', undefined] as const)
      for (const dim of [1, 2, 3] as const) for (const v of VALUES) expect(formatMeasure(v, dim, unit)).toBe(coreMeasure(v, dim, unit));
  });

  it('formatChange', () => {
    for (const unit of ['mm', 'm', undefined] as const)
      for (const dim of [1, 2, 3] as const)
        for (const [before, after] of [
          [1000, 1200],
          [52_345.6, 55_100],
          [10, 10],
          [0, 5],
          [8, 7.5],
          [1e6, 1.0000004e6],
        ]) {
          const delta = after - before;
          const core = coreChange({ base: before, target: after, delta, percent: before !== 0 ? (delta / Math.abs(before)) * 100 : null }, dim, unit);
          expect(formatChange({ before, after }, dim, unit)).toBe(core);
        }
  });

  it('formatSize keeps the unit once', () => {
    expect(formatSize([100, 60, 10], 'mm')).toBe('100 × 60 × 10 mm');
    expect(formatSize([0.1, 0.06, 0.01], 'm')).toBe('100 × 60 × 10 mm');
    expect(formatSize([8, 8, 1.8], null)).toBe('8 × 8 × 1.8');
  });
});
