import { writeFile } from 'node:fs/promises';
import { formatMeasure, formatUnit, sameMeasure, sectionMesh, type IMesh, type ISection, type MetricUnit, type SectionAxis } from 'polymerge-core';
import { loadMeshFile, loadMeshPair, type LoadedFile } from '../io.js';
import { coord, formatSize, palette } from '../report.js';

export interface SectionOptions {
  x?: string;
  y?: string;
  z?: string;
  /** Write the cut as an SVG drawing. */
  svg?: string;
  json?: boolean;
}

/** The plane from --x / --y / --z: a number, or a percentage of the model's extent ("50%"). */
export function parsePlane(o: SectionOptions, mesh: IMesh): { axis: SectionAxis; value: number } {
  const given = (['x', 'y', 'z'] as const).filter((a) => o[a] !== undefined);
  if (given.length > 1) throw new Error('give one plane: --x, --y or --z');
  const axis: SectionAxis = given[0] ?? 'z';
  const k = { x: 0, y: 1, z: 2 }[axis];
  const { min, max } = mesh.metadata.bounds;
  const raw = o[axis] ?? '50%';
  const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(raw.trim());
  const value = pct ? min[k] + (Number(pct[1]) / 100) * (max[k] - min[k]) : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${axis} must be a number or a percentage like 50% (got "${raw}")`);
  return { axis, value };
}

const u = (unit: MetricUnit | undefined) => (x: number) => formatMeasure(x, 1, unit);

/** The loops of a cut, one line each, largest first. */
export function formatSection(s: ISection, name: string, unit: MetricUnit | undefined, limit = 12): string[] {
  const c = palette();
  const len = u(unit);
  const out = [`${c.bold(name)}  ${c.dim(`${s.axis} = ${coord(s.value)}`)}`];
  if (s.loops.length === 0) {
    out.push(c.dim('  the plane does not cut the model here'));
    return out;
  }
  let outlines = 0;
  let holes = 0;
  for (const l of s.loops.slice(0, limit)) {
    const w = l.max[0] - l.min[0];
    const h = l.max[1] - l.min[1];
    const centre = `(${coord(l.center[{ x: 0, y: 1, z: 2 }[s.uAxis]])}, ${coord(l.center[{ x: 0, y: 1, z: 2 }[s.vAxis]])})`;
    const shape = l.circleDiameter !== null ? `circle Ø${len(l.circleDiameter)}` : formatSize([w, h], unit);
    let label: string;
    if (!l.closed) label = c.modified('open line');
    else if (l.area >= 0) label = `outline ${++outlines}`;
    else label = `hole ${++holes}`;
    out.push(
      `  ${label.padEnd(10)} ${shape.padEnd(22)} at ${centre.padEnd(18)} perimeter ${len(l.perimeter).padEnd(10)}` +
        (l.closed ? ` area ${formatMeasure(Math.abs(l.area), 2, unit)}` : ''),
    );
  }
  if (s.loops.length > limit) out.push(c.dim(`  … ${s.loops.length - limit} more loop(s) (--json lists them all)`));
  out.push(`  ${c.bold('material in the cut')} ${formatMeasure(s.area, 2, unit)}${unit ? '' : c.dim(" (in the file's units)")}`);
  return out;
}

/** An SVG drawing of one or two cuts (the second drawn over the first), u to the right, v up. */
export function sectionSvg(cuts: { section: ISection; color: string; dashed?: boolean }[]): string {
  let lo = [Infinity, Infinity];
  let hi = [-Infinity, -Infinity];
  for (const { section } of cuts) {
    for (const l of section.loops) {
      lo = [Math.min(lo[0], l.min[0]), Math.min(lo[1], l.min[1])];
      hi = [Math.max(hi[0], l.max[0]), Math.max(hi[1], l.max[1])];
    }
  }
  if (!Number.isFinite(lo[0])) lo = hi = [0, 0];
  const pad = 0.05 * Math.max(hi[0] - lo[0], hi[1] - lo[1], 1e-9);
  const w = hi[0] - lo[0] + 2 * pad;
  const h = hi[1] - lo[1] + 2 * pad;
  const stroke = Math.max(w, h) / 400;
  const paths = cuts.map(({ section, color, dashed }) => {
    const ui = { x: 0, y: 1, z: 2 }[section.uAxis];
    const vi = { x: 0, y: 1, z: 2 }[section.vAxis];
    const d = section.loops
      .map((l) => l.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(p[ui] - lo[0] + pad).toFixed(4)} ${(hi[1] - p[vi] + pad).toFixed(4)}`).join(' ') + (l.closed ? ' Z' : ''))
      .join(' ');
    return `  <path d="${d}" fill="${dashed ? 'none' : color}" fill-opacity="0.15" fill-rule="evenodd" stroke="${color}" stroke-width="${stroke.toFixed(4)}"${dashed ? ` stroke-dasharray="${(4 * stroke).toFixed(4)}"` : ''}/>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(4)} ${h.toFixed(4)}" width="800" height="${Math.round((800 * h) / w)}">`,
    `  <rect width="100%" height="100%" fill="#ffffff"/>`,
    ...paths,
    '</svg>',
    '',
  ].join('\n');
}

/** `polymerge section <file> [<file2>] [--x|--y|--z <value>] [--svg out.svg] [--json]`. */
export async function runSection(paths: string[], o: SectionOptions): Promise<number> {
  const files: LoadedFile[] = paths.length === 2 ? await loadMeshPair({ path: paths[0] }, { path: paths[1] }) : [await loadMeshFile(paths[0])];
  const { axis, value } = parsePlane(o, files[0].mesh);
  const cuts = files.map((f) => ({ file: f, section: sectionMesh(f.mesh, axis, value), unit: formatUnit(f.mesh.metadata.format) }));
  if (o.svg) {
    await writeFile(o.svg, sectionSvg(cuts.map((cut, i) => ({ section: cut.section, color: i === 0 && cuts.length > 1 ? '#6b7280' : '#2563eb', dashed: i === 0 && cuts.length > 1 }))));
  }
  if (o.json) {
    process.stdout.write(JSON.stringify(cuts.map((cut) => ({ file: cut.file.fileName, unit: cut.unit ?? null, ...cut.section })), null, 2) + '\n');
    return 0;
  }
  const c = palette();
  const lines: string[] = [c.bold(`polymerge section  ${axis} = ${coord(value)}`)];
  for (const cut of cuts) lines.push('', ...formatSection(cut.section, cut.file.fileName, cut.unit));
  if (cuts.length === 2) {
    const [a, b] = cuts;
    const unit = a.unit ?? b.unit;
    const d = sameMeasure(a.section.area, b.section.area) ? 0 : b.section.area - a.section.area;
    const pct = a.section.area !== 0 ? ` (${d >= 0 ? '+' : '−'}${Math.abs((100 * d) / a.section.area).toFixed(1)}%)` : '';
    lines.push(
      '',
      `${c.bold('Change')}  material ${d === 0 ? 'unchanged' : `${d > 0 ? '+' : '−'}${formatMeasure(Math.abs(d), 2, unit)}${pct}`} · loops ${a.section.loops.length} → ${b.section.loops.length}`,
    );
  }
  if (o.svg) lines.push('', `Wrote ${o.svg}`);
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
