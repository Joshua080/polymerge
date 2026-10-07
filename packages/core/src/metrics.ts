/**
 * Geometry metrics of a mesh — size, surface area, volume, and whether the surface is closed —
 * and their change between two versions. Isomorphic and O(faces): one pass over the triangles,
 * one counting sort of the edges.
 *
 * Volume is only meaningful for a CLOSED, consistently oriented surface (every edge shared by
 * exactly two faces that traverse it in opposite directions); for anything else it is null and
 * the counts say why (open edges = holes, non-manifold edges, flipped faces). A closed surface
 * whose normals point inwards has a negative signed volume: it is reported as its absolute value
 * with `insideOut` set.
 */
import { buildComponents } from './diff/components.js';
import type { IMesh, IMeshMetrics, IMetricChange, IMetricsComparison, MetricUnit, SourceFormat, Vec3 } from './types.js';

/** The length unit a source format states, if any. */
export function formatUnit(format: SourceFormat): MetricUnit | undefined {
  if (format === 'step' || format === '3mf') return 'mm';
  if (format === 'gltf' || format === 'glb') return 'm';
  return undefined;
}

/**
 * Edge census in one counting sort: every edge keyed by its lower vertex, with the higher vertex
 * and the direction packed together (hi·2 + 1 when the face runs lo → hi), so each vertex's short
 * list is sorted and scanned once.
 */
function edgeCensus(vertexCount: number, faces: Uint32Array): { open: number; nonManifold: number; flipped: number } {
  const n = faces.length;
  const start = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < n; i += 3) {
    const a = faces[i];
    const b = faces[i + 1];
    const c = faces[i + 2];
    start[(a < b ? a : b) + 1]++;
    start[(b < c ? b : c) + 1]++;
    start[(c < a ? c : a) + 1]++;
  }
  for (let v = 0; v < vertexCount; v++) start[v + 1] += start[v];
  const fill = start.slice(0, vertexCount);
  // hi·2 + direction fits in 32 bits for any mesh that fits in memory (< 2³¹ vertices).
  const keys = new Uint32Array(n);
  const put = (a: number, b: number): void => {
    if (a < b) keys[fill[a]++] = b * 2 + 1;
    else keys[fill[b]++] = a * 2;
  };
  for (let i = 0; i < n; i += 3) {
    put(faces[i], faces[i + 1]);
    put(faces[i + 1], faces[i + 2]);
    put(faces[i + 2], faces[i]);
  }
  let open = 0;
  let nonManifold = 0;
  let flipped = 0;
  for (let v = 0; v < vertexCount; v++) {
    const s = start[v];
    const e = start[v + 1];
    if (e - s > 1) {
      if (e - s <= 24) {
        for (let i = s + 1; i < e; i++) {
          const x = keys[i];
          let j = i - 1;
          while (j >= s && keys[j] > x) {
            keys[j + 1] = keys[j];
            j--;
          }
          keys[j + 1] = x;
        }
      } else keys.subarray(s, e).sort();
    }
    let i = s;
    while (i < e) {
      const hi = keys[i] >>> 1;
      let j = i;
      let forward = 0;
      while (j < e && keys[j] >>> 1 === hi) {
        forward += keys[j] & 1;
        j++;
      }
      const count = j - i;
      if (count === 1) open++;
      else if (count === 2) {
        if (forward !== 1) flipped++;
      } else nonManifold++;
      i = j;
    }
  }
  return { open, nonManifold, flipped };
}

export function computeMetrics(mesh: IMesh): IMeshMetrics {
  const p = mesh.positions;
  const f = mesh.faces;
  const { min, max } = mesh.metadata.bounds;
  // Work relative to the box centre: keeps the volume sum well conditioned far from the origin.
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2;
  let area = 0;
  let volume6 = 0;
  // Area-weighted and volume-weighted sums for the centroid.
  let ax = 0;
  let ay = 0;
  let az = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (let i = 0; i < f.length; i += 3) {
    const a = f[i] * 3;
    const b = f[i + 1] * 3;
    const c = f[i + 2] * 3;
    const x0 = p[a] - cx;
    const y0 = p[a + 1] - cy;
    const z0 = p[a + 2] - cz;
    const x1 = p[b] - cx;
    const y1 = p[b + 1] - cy;
    const z1 = p[b + 2] - cz;
    const x2 = p[c] - cx;
    const y2 = p[c + 1] - cy;
    const z2 = p[c + 2] - cz;
    const ux = x1 - x0;
    const uy = y1 - y0;
    const uz = z1 - z0;
    const wx = x2 - x0;
    const wy = y2 - y0;
    const wz = z2 - z0;
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    const t = Math.hypot(nx, ny, nz) / 2;
    area += t;
    ax += (t * (x0 + x1 + x2)) / 3;
    ay += (t * (y0 + y1 + y2)) / 3;
    az += (t * (z0 + z1 + z2)) / 3;
    // Signed volume of the tetrahedron (centre, a, b, c) × 6.
    const v6 = x0 * (y1 * z2 - z1 * y2) - y0 * (x1 * z2 - z1 * x2) + z0 * (x1 * y2 - y1 * x2);
    volume6 += v6;
    vx += (v6 * (x0 + x1 + x2)) / 4;
    vy += (v6 * (y0 + y1 + y2)) / 4;
    vz += (v6 * (z0 + z1 + z2)) / 4;
  }
  const edges = edgeCensus(mesh.vertexCount, f);
  const closed = mesh.faceCount > 0 && edges.open === 0 && edges.nonManifold === 0;
  const signed = volume6 / 6;
  const hasVolume = closed && edges.flipped === 0 && signed !== 0;
  const centroid: Vec3 =
    hasVolume && volume6 !== 0
      ? [cx + vx / volume6, cy + vy / volume6, cz + vz / volume6]
      : area > 0
        ? [cx + ax / area, cy + ay / area, cz + az / area]
        : [cx, cy, cz];
  const metrics: IMeshMetrics = {
    vertices: mesh.vertexCount,
    faces: mesh.faceCount,
    parts: buildComponents(mesh.vertexCount, f).count,
    bounds: { min: [...min], max: [...max] },
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    surfaceArea: area,
    volume: hasVolume ? Math.abs(signed) : null,
    closed,
    openEdges: edges.open,
    nonManifoldEdges: edges.nonManifold,
    flippedEdges: edges.flipped,
    insideOut: hasVolume && signed < 0,
    centroid,
  };
  const unit = formatUnit(mesh.metadata.format);
  if (unit) metrics.unit = unit;
  return metrics;
}

function change(base: number, target: number): IMetricChange {
  return { base, target, delta: target - base, percent: base !== 0 ? ((target - base) / Math.abs(base)) * 100 : null };
}

/**
 * The unit to show a comparison in: the one both versions state, or the only one stated (an STL
 * against a 3MF of the same part is almost always in mm too); undefined when they disagree.
 */
export function displayUnit(c: IMetricsComparison): MetricUnit | undefined {
  if (c.unitsDiffer) return undefined;
  return c.base.unit ?? c.target.unit;
}

export function compareMetrics(base: IMeshMetrics, target: IMeshMetrics): IMetricsComparison {
  return {
    base,
    target,
    volume: base.volume !== null && target.volume !== null ? change(base.volume, target.volume) : null,
    surfaceArea: change(base.surfaceArea, target.surfaceArea),
    size: [change(base.size[0], target.size[0]), change(base.size[1], target.size[1]), change(base.size[2], target.size[2])],
    unitsDiffer: base.unit !== target.unit && base.unit !== undefined && target.unit !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Formatting (shared by the CLI, the viewer and the PR Action, so they read alike)
// ---------------------------------------------------------------------------

const TO_MM: Record<MetricUnit, number> = { mm: 1, m: 1000 };

/** A number for people: 4 significant figures, no exponent between 0.001 and 10⁹, no trailing zeros. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const a = Math.abs(value);
  if (a >= 1e9 || a < 1e-3) return value.toExponential(2);
  const digits = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
  const s = value.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * A length (dimension 1), area (2) or volume (3) with a sensible unit: with a known unit the value
 * is shown in mm, cm or m (mm³ / cm³ / m³ …) by size; with none it is a bare number in the
 * file's own units. `magnitude` (default: the value itself) picks the unit, so a change can be
 * written in the same unit as the values it is the change of.
 */
export function formatMeasure(value: number, dimension: 1 | 2 | 3, unit: MetricUnit | undefined, magnitude = value): string {
  if (!unit) return formatNumber(value);
  const scale = TO_MM[unit] ** dimension;
  const mm = value * scale;
  const a = Math.abs(magnitude * scale);
  // Lengths in mm (as on drawings) up to 10 m; areas and volumes in mm² / mm³ while small, then
  // cm² / cm³ (what slicers and filament estimates use), then m² / m³.
  if (dimension === 1) return a < 10_000 ? `${formatNumber(mm)} mm` : `${formatNumber(mm / 1000)} m`;
  if (dimension === 2) return a < 1000 ? `${formatNumber(mm)} mm²` : a < 1e7 ? `${formatNumber(mm / 100)} cm²` : `${formatNumber(mm / 1e6)} m²`;
  return a < 1000 ? `${formatNumber(mm)} mm³` : a < 1e9 ? `${formatNumber(mm / 1000)} cm³` : `${formatNumber(mm / 1e9)} m³`;
}

/** "+2.3 cm³ (+4.1%)", "−0.5 mm (−1%)", "no change". */
export function formatChange(c: IMetricChange, dimension: 1 | 2 | 3, unit: MetricUnit | undefined): string {
  if (c.delta === 0) return 'no change';
  const sign = c.delta > 0 ? '+' : '−';
  const amount = formatMeasure(Math.abs(c.delta), dimension, unit, Math.max(Math.abs(c.base), Math.abs(c.target)));
  if (c.percent === null) return `${sign}${amount}`;
  const pct = Math.abs(c.percent);
  const pctText = pct >= 10 ? pct.toFixed(0) : pct >= 0.1 ? pct.toFixed(1) : pct > 0 ? '<0.1' : '0';
  return `${sign}${amount} (${sign}${pctText}%)`;
}

/** Why a mesh has no volume, in a few words (or null when it has one). */
export function volumeNote(m: IMeshMetrics): string | null {
  if (m.volume !== null) return m.insideOut ? 'faces point inwards' : null;
  const reasons: string[] = [];
  if (m.openEdges > 0) reasons.push(`${m.openEdges} open edge${m.openEdges === 1 ? '' : 's'}`);
  if (m.nonManifoldEdges > 0) reasons.push(`${m.nonManifoldEdges} non-manifold edge${m.nonManifoldEdges === 1 ? '' : 's'}`);
  if (m.flippedEdges > 0) reasons.push(`${m.flippedEdges} edge${m.flippedEdges === 1 ? '' : 's'} between flipped faces`);
  return reasons.length > 0 ? `not closed: ${reasons.join(', ')}` : 'no enclosed volume';
}
