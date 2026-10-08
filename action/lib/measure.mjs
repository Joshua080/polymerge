/**
 * Sizes, areas and volumes for the comment, written exactly as polymerge-core's formatMeasure /
 * formatChange write them (the CLI and the viewer use those). A copy rather than an import: the
 * post step loads no package code. action/test/measure.test.ts checks that both agree.
 */

const TO_MM = { mm: 1, m: 1000 };

/** Four significant figures, no exponent between 0.001 and 10⁹, no trailing zeros. */
export function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const a = Math.abs(value);
  if (a >= 1e9 || a < 1e-3) return value.toExponential(2);
  const digits = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
  const s = value.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * A length (1), area (2) or volume (3) in mm / cm / m by size, or a bare number without a unit.
 * @param {number} value
 * @param {1 | 2 | 3} dimension
 * @param {'mm' | 'm' | null | undefined} unit
 * @param {number} [magnitude] picks the unit (default: the value)
 */
export function formatMeasure(value, dimension, unit, magnitude = value) {
  if (!unit) return formatNumber(value);
  const scale = TO_MM[unit] ** dimension;
  const mm = value * scale;
  const a = Math.abs(magnitude * scale);
  if (dimension === 1) return a < 10_000 ? `${formatNumber(mm)} mm` : `${formatNumber(mm / 1000)} m`;
  if (dimension === 2) return a < 1000 ? `${formatNumber(mm)} mm²` : a < 1e7 ? `${formatNumber(mm / 100)} cm²` : `${formatNumber(mm / 1e6)} m²`;
  return a < 1000 ? `${formatNumber(mm)} mm³` : a < 1e9 ? `${formatNumber(mm / 1000)} cm³` : `${formatNumber(mm / 1e9)} m³`;
}

/**
 * "+2.3 cm³ (+4.1%)", "no change".
 * @param {{ before: number, after: number }} c
 * @param {1 | 2 | 3} dimension
 * @param {'mm' | 'm' | null | undefined} unit
 */
export function formatChange(c, dimension, unit) {
  const delta = c.after - c.before;
  if (delta === 0) return 'no change';
  const sign = delta > 0 ? '+' : '−';
  const amount = formatMeasure(Math.abs(delta), dimension, unit, Math.max(Math.abs(c.before), Math.abs(c.after)));
  if (c.before === 0) return `${sign}${amount}`;
  const pct = Math.abs((delta / Math.abs(c.before)) * 100);
  const pctText = pct >= 10 ? pct.toFixed(0) : pct >= 0.1 ? pct.toFixed(1) : pct > 0 ? '<0.1' : '0';
  return `${sign}${amount} (${sign}${pctText}%)`;
}

/**
 * "100 × 60 × 10 mm".
 * @param {number[]} size
 * @param {'mm' | 'm' | null | undefined} unit
 */
export function formatSize(size, unit) {
  const magnitude = Math.max(...size.map(Math.abs));
  const parts = size.map((v) => formatMeasure(v, 1, unit, magnitude));
  if (!unit) return parts.join(' × ');
  return `${parts.map((p) => p.split(' ')[0]).join(' × ')} ${parts[0].split(' ')[1]}`;
}
