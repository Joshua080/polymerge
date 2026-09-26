/**
 * Length-unit conversion detection. A similarity alignment's scale that lies within
 * UNIT_SNAP_TOLERANCE of a conversion factor between two known units (e.g. 25.4 for
 * inches → millimetres) is snapped to that exact factor and labelled. The known factors
 * are far apart (the closest pair, 10 vs 12, differs by 20%), so the snap is unambiguous.
 */
import type { IUnitConversion, LengthUnit } from '../types.js';

/** Relative tolerance for snapping a fitted scale to a unit factor (0.5%). */
export const UNIT_SNAP_TOLERANCE = 0.005;

/**
 * Scales closer to 1 than this are not modelled as a uniform scale at all: a 0.3% shrink
 * compensation is a real geometric edit (reported as moved vertices), and a remesh's
 * faceting error must never be absorbed as a fake scale.
 */
export const MIN_SCALE_DEVIATION = 0.015;

const MM_PER_UNIT: Readonly<Record<LengthUnit, number>> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
const UNITS = Object.keys(MM_PER_UNIT) as LengthUnit[];

/** Every ordered unit pair with its factor (target length = factor × base length). */
export const UNIT_CONVERSIONS: readonly IUnitConversion[] = UNITS.flatMap((from) =>
  UNITS.filter((to) => to !== from).map((to) => ({ from, to, factor: MM_PER_UNIT[from] / MM_PER_UNIT[to] })),
);

/** The unit conversion whose factor is within `tol` (relative) of `scale`, if any. */
export function detectUnits(scale: number, tol = UNIT_SNAP_TOLERANCE): IUnitConversion | undefined {
  if (!(scale > 0)) return undefined;
  let best: IUnitConversion | undefined;
  let bestErr = Infinity;
  for (const u of UNIT_CONVERSIONS) {
    const err = Math.abs(Math.log(scale / u.factor));
    if (err < bestErr) {
      bestErr = err;
      best = u;
    }
  }
  return bestErr <= Math.log1p(tol) ? { ...best! } : undefined;
}

/** Unit factors within `ratio` (multiplicative) of `scale` — extra initial scale hypotheses. */
export function nearbyUnitFactors(scale: number, ratio: number): number[] {
  const out: number[] = [];
  for (const u of UNIT_CONVERSIONS) {
    if (u.factor >= scale / ratio && u.factor <= scale * ratio && !out.some((f) => Math.abs(f / u.factor - 1) < 1e-12)) {
      out.push(u.factor);
    }
  }
  return out.sort((a, b) => Math.abs(Math.log(a / scale)) - Math.abs(Math.log(b / scale)));
}

export function describeUnits(u: IUnitConversion): string {
  return `${u.from} → ${u.to} (×${Number(u.factor.toPrecision(6))})`;
}
