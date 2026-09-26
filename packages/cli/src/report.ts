import {
  describeVertexChange,
  VertexStatus,
  type IDiffLogger,
  type IDiffResult,
  type IMesh,
  type IMeshSummary,
  type Mat4,
} from '@polymerge/core';

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

export function formatDiffReport(result: IDiffResult, base: IMesh, target: IMesh, opts: ReportOptions): string {
  const c = palette();
  const out: string[] = [];
  out.push(c.bold('polymerge diff'));
  out.push(describeMesh('base', result.base, opts.baseName));
  out.push(describeMesh('target', result.target, opts.targetName));
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
