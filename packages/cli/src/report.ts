import {
  describeVertexChange,
  displayUnit,
  formatChange,
  formatMeasure,
  stepInfo,
  VertexStatus,
  volumeNote,
  type IDiffLogger,
  type IDiffResult,
  type IMesh,
  type IMeshMetrics,
  type IMeshSummary,
  type IMetricsComparison,
  type Mat4,
  type MetricUnit,
} from 'polymerge-core';

const useColor = (stream: NodeJS.WriteStream) => stream.isTTY === true && !process.env.NO_COLOR;

export interface Palette {
  added: (s: string) => string;
  removed: (s: string) => string;
  modified: (s: string) => string;
  unchanged: (s: string) => string;
  bold: (s: string) => string;
  dim: (s: string) => string;
}

export function palette(stream: NodeJS.WriteStream = process.stdout): Palette {
  const wrap = (code: string) => (s: string) => (useColor(stream) ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    added: wrap('32'),
    removed: wrap('31'),
    modified: wrap('33'),
    unchanged: wrap('90'),
    bold: wrap('1'),
    dim: wrap('2'),
  };
}

/** Engine log sink for the CLI: stderr, so stdout stays clean for `--json -`. */
export function stderrLogger(verbose: boolean): IDiffLogger {
  const c = palette(process.stderr);
  return {
    info: (m) => process.stderr.write(c.dim(m) + '\n'),
    warn: (m) => process.stderr.write(c.modified(m) + '\n'),
    debug: verbose ? (m) => process.stderr.write(c.dim(m) + '\n') : undefined,
  };
}

export const silentLogger: IDiffLogger = { info: () => {}, warn: () => {} };

export function fmt(n: number, digits = 4): string {
  if (n === 0) return '0';
  const a = Math.abs(n);
  return a >= 1e5 || a < 1e-3 ? n.toExponential(3) : n.toFixed(digits);
}

function describeMesh(label: string, s: IMeshSummary, name: string): string {
  return `  ${label.padEnd(6)} ${name}  ${s.format.toUpperCase()}  ${s.vertexCount} vertices · ${s.faceCount} faces`;
}

/**
 * Rotation angle (deg), axis, uniform scale and translation of a column-major similarity
 * 4x4 (3×3 block = scale·R).
 */
export function decomposeRigid(m: Mat4): {
  angleDeg: number;
  axis: [number, number, number];
  scale: number;
  translation: [number, number, number];
} {
  const det =
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  const scale = det > 0 ? Math.cbrt(det) : Math.hypot(m[0], m[1], m[2]) || 1;
  const r = (row: number, col: number) => m[col * 4 + row] / scale;
  const trace = r(0, 0) + r(1, 1) + r(2, 2);
  const angle = Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2)));
  let axis: [number, number, number] = [r(2, 1) - r(1, 2), r(0, 2) - r(2, 0), r(1, 0) - r(0, 1)];
  const len = Math.hypot(...axis);
  axis = len > 1e-12 ? [axis[0] / len, axis[1] / len, axis[2] / len] : [0, 0, 1];
  return { angleDeg: (angle * 180) / Math.PI, axis, scale, translation: [m[12], m[13], m[14]] };
}

export interface ReportOptions {
  baseName: string;
  targetName: string;
  /** How many individual vertex moves to list. */
  topMoves: number;
}

/** How STEP models were tessellated, and what that means for the counts. */
export function stepNote(base: IMesh, target: IMesh): string | null {
  const [b, t] = [stepInfo(base), stepInfo(target)];
  if (!b && !t) return null;
  const tol = !b || !t ? `${(b ?? t)!.deflection} mm` : b.deflection === t.deflection ? `${b.deflection} mm for both` : `${b.deflection} / ${t.deflection} mm`;
  return `  STEP   tessellated by OpenCascade (deflection ${tol}); a flat face re-triangulated around an edit counts as modified`;
}

/** "100 × 60 × 10 mm" (or bare numbers when the unit is unknown). */
export function formatSize(size: readonly number[], unit: MetricUnit | undefined): string {
  const magnitude = Math.max(...size.map(Math.abs));
  const parts = size.map((v) => formatMeasure(v, 1, unit, magnitude));
  // Keep the unit once, at the end: "100 × 60 × 10 mm".
  const suffix = unit ? ` ${parts[0].split(' ')[1]}` : '';
  return parts.map((p) => (unit ? p.split(' ')[0] : p)).join(' × ') + suffix;
}

/** Volume, or why there is none. */
function volumeText(m: IMeshMetrics, unit: MetricUnit | undefined): string {
  return m.volume !== null ? formatMeasure(m.volume, 3, unit) : '—';
}

/** Metric lines of one model (polymerge info). */
export function formatMetricsLines(m: IMeshMetrics, label = (s: string) => s): string[] {
  const unit = m.unit;
  const note = volumeNote(m);
  return [
    `  ${label('size')}          ${formatSize(m.size, unit)}${unit ? '' : '  (in the file\'s units)'}`,
    `  ${label('surface area')}  ${formatMeasure(m.surfaceArea, 2, unit)}`,
    `  ${label('volume')}        ${volumeText(m, unit)}${note ? `  (${note})` : '  (closed)'}`,
    `  ${label('parts')}         ${m.parts}`,
  ];
}

/** The "Geometry" table of a diff: base, target and the change, per metric. */
export function formatMetricsTable(cmp: IMetricsComparison, c: Palette): string[] {
  const unit = displayUnit(cmp);
  const rows: [string, string, string, string][] = [];
  const sizeChanges = (['x', 'y', 'z'] as const)
    .map((axis, i) => (cmp.size[i].delta !== 0 ? `${axis} ${formatChange(cmp.size[i], 1, unit).replace(/ \(.*\)$/, '')}` : ''))
    .filter(Boolean);
  rows.push(['size', formatSize(cmp.base.size, unit), formatSize(cmp.target.size, unit), sizeChanges.join(', ') || 'no change']);
  rows.push(['volume', volumeText(cmp.base, unit), volumeText(cmp.target, unit), cmp.volume ? formatChange(cmp.volume, 3, unit) : '']);
  rows.push(['surface area', formatMeasure(cmp.surfaceArea.base, 2, unit), formatMeasure(cmp.surfaceArea.target, 2, unit), formatChange(cmp.surfaceArea, 2, unit)]);
  if (cmp.base.parts !== cmp.target.parts || cmp.base.parts > 1) {
    const d = cmp.target.parts - cmp.base.parts;
    rows.push(['parts', String(cmp.base.parts), String(cmp.target.parts), d === 0 ? 'no change' : `${d > 0 ? '+' : '−'}${Math.abs(d)}`]);
  }
  const closed = (m: IMeshMetrics) => (m.volume !== null ? 'yes' : (volumeNote(m) ?? 'no').replace(/^not closed: /, 'no: '));
  rows.push(['closed', closed(cmp.base), closed(cmp.target), '']);
  const w = [Math.max(...rows.map((r) => r[0].length)) + 2, Math.max(4, ...rows.map((r) => r[1].length)), Math.max(6, ...rows.map((r) => r[2].length))];
  const out = [`${c.bold('Geometry'.padEnd(w[0] + 2))}${c.dim('base'.padEnd(w[1] + 2))}${c.dim('target'.padEnd(w[2] + 2))}${c.dim('change')}`];
  for (const [name, b, t, d] of rows) {
    const changed = d !== '' && d !== 'no change';
    out.push(`  ${name.padEnd(w[0])}${b.padEnd(w[1] + 2)}${t.padEnd(w[2] + 2)}${changed ? c.modified(d) : c.dim(d)}`.trimEnd());
  }
  if (cmp.unitsDiffer) out.push(c.dim(`  The files state different units (${cmp.base.unit} and ${cmp.target.unit}); the numbers are each in their own.`));
  else if (!unit) out.push(c.dim('  In the files\' own units (STL, OBJ and PLY do not state one).'));
  return out;
}

export function formatDiffReport(result: IDiffResult, base: IMesh, target: IMesh, opts: ReportOptions): string {
  const c = palette();
  const out: string[] = [];
  out.push(c.bold('polymerge diff'));
  out.push(describeMesh('base', result.base, opts.baseName));
  out.push(describeMesh('target', result.target, opts.targetName));
  const step = stepNote(base, target);
  if (step) out.push(c.dim(step));
  out.push('');
  out.push(`${c.bold('Correspondence:')} ${result.tierName}`);
  for (const a of result.attempts) {
    const mark = a.accepted ? c.added('✓') : c.removed('✗');
    const cmp = a.accepted ? '≥' : '<';
    out.push(
      `  ${mark} Tier ${a.tier}  score ${a.score.toFixed(3)} ${cmp} ${a.threshold.toFixed(3)}  ${c.dim(a.reason)} ${c.dim(`(${a.durationMs.toFixed(1)} ms)`)}`,
    );
  }
  out.push('');
  const v = result.stats.vertices;
  const f = result.stats.faces;
  out.push(
    `${c.bold('Vertices')}  ${c.unchanged(`unchanged ${v.unchanged}`)}  ${c.modified(`moved ${v.moved}`)}  ${c.added(`added ${v.added}`)}  ${c.removed(`removed ${v.removed}`)}`,
  );
  out.push(
    `${c.bold('Faces   ')}  ${c.unchanged(`unchanged ${f.unchanged}`)}  ${c.modified(`modified ${f.modified}`)}  ${c.added(`added ${f.added}`)}  ${c.removed(`removed ${f.removed}`)}`,
  );
  if (v.moved > 0) {
    out.push(`${c.bold('Displacement')}  max ${fmt(result.stats.maxDisplacement)}  mean ${fmt(result.stats.meanDisplacement)}`);
  }
  if (!result.alignment.isIdentity) {
    const { angleDeg, axis, translation } = decomposeRigid(result.alignment.matrix);
    const a = result.alignment;
    const scaleText = a.units
      ? `units ${a.units.from} → ${a.units.to} (×${Number(a.units.factor.toPrecision(6))}), `
      : a.scale !== undefined && a.scale !== 1
        ? `uniform scale ×${Number(a.scale.toPrecision(6))}, `
        : '';
    out.push(
      `${c.bold('Alignment')}  ${scaleText}rotation ${angleDeg.toFixed(2)}° about (${axis.map((x) => x.toFixed(3)).join(', ')}), ` +
        `translation (${translation.map((x) => fmt(x)).join(', ')}), rms ${fmt(a.rmsError)}`,
    );
  }
  const parts = result.parts ?? [];
  if (parts.length > 0) {
    out.push(c.bold(`Moved parts (${parts.length}):`));
    for (const p of parts) {
      const name = p.baseName ?? p.targetName ?? `${p.baseVertices.length}-vertex part`;
      const how = p.source === 'registration' ? 're-matched (was removed + added)' : 'matched';
      out.push(
        `  ${c.modified('•')} "${name}": rotation ${p.rotationDeg.toFixed(2)}°, centroid shift (${p.centroidShift.map((x) => fmt(x)).join(', ')})` +
          `${p.deformedVertices > 0 ? `, ${p.deformedVertices} vertex(es) also edited` : ''} ${c.dim(`[${how}]`)}`,
      );
    }
  }
  if (result.metrics) {
    out.push('');
    out.push(...formatMetricsTable(result.metrics, c));
  }
  if (opts.topMoves > 0 && v.moved > 0) {
    const moved: number[] = [];
    for (let t = 0; t < result.targetVertexStatus.length; t++) {
      if (result.targetVertexStatus[t] === VertexStatus.Moved) moved.push(t);
    }
    moved.sort((a, b) => result.displacement[b] - result.displacement[a] || a - b);
    out.push('');
    out.push(c.bold(`Largest vertex moves (${Math.min(opts.topMoves, moved.length)} of ${moved.length}):`));
    for (const t of moved.slice(0, opts.topMoves)) {
      const ch = describeVertexChange(result, base, target, 'target', t);
      const d = ch.delta ? `Δ (${ch.delta.map((x) => fmt(x)).join(', ')})` : '';
      out.push(`  base #${ch.baseIndex} → target #${ch.targetIndex}  ${d}  |Δ| ${fmt(ch.distance)}`);
    }
  }
  out.push('');
  out.push(c.dim(`Computed in ${result.durationMs.toFixed(1)} ms.`));
  return out.join('\n');
}

export function hasChanges(result: IDiffResult): boolean {
  const v = result.stats.vertices;
  const f = result.stats.faces;
  return v.moved + v.added + v.removed + f.modified + f.added + f.removed > 0;
}
