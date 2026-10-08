import { formatMeasure, formatUnit, SurfaceLocator, type IMesh, type Vec3 } from 'polymerge-core';
import { loadMeshFile } from '../io.js';
import { coord, palette, point } from '../report.js';

export interface MeasureOptions {
  /** Measure the points as given, without snapping them to the surface. */
  snap?: boolean;
  json?: boolean;
}

/** "10,0,5" or "10 0 5" → a point; "v:123" → that vertex's position. */
export function parsePoint(raw: string, mesh: IMesh): Vec3 {
  const vertex = /^v(?:ertex)?:(\d+)$/i.exec(raw.trim());
  if (vertex) {
    const i = Number(vertex[1]);
    if (i >= mesh.vertexCount) throw new Error(`there is no vertex ${i} (the model has ${mesh.vertexCount})`);
    return [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
  }
  const parts = raw.trim().split(/[\s,;]+/).map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite)) throw new Error(`a point is x,y,z (like 10,0,5) or v:<vertex number> (got "${raw}")`);
  return parts as Vec3;
}

const vec = (v: Vec3) => point(v);

/** `polymerge measure <file> <point> <point>`: the distance between two points on the model. */
export async function runMeasure(file: string, rawA: string, rawB: string, o: MeasureOptions): Promise<number> {
  const { mesh, fileName } = await loadMeshFile(file);
  const unit = formatUnit(mesh.metadata.format);
  const given = [parsePoint(rawA, mesh), parsePoint(rawB, mesh)];
  const locator = o.snap === false ? null : new SurfaceLocator(mesh);
  const ends = given.map((p) => {
    const hit = locator?.nearest(p) ?? null;
    return { given: p, point: hit?.point ?? p, offset: hit?.distance ?? 0, group: hit ? (mesh.groups[hit.group]?.name ?? '') : '' };
  });
  const [a, b] = ends;
  const delta: Vec3 = [b.point[0] - a.point[0], b.point[1] - a.point[1], b.point[2] - a.point[2]];
  const distance = Math.hypot(...delta);
  if (o.json) {
    process.stdout.write(JSON.stringify({ file: fileName, unit: unit ?? null, snapped: locator !== null, from: a, to: b, delta, distance }, null, 2) + '\n');
    return 0;
  }
  const c = palette();
  const len = (x: number) => formatMeasure(x, 1, unit);
  const several = mesh.groups.length > 1;
  const line = (label: string, e: (typeof ends)[number]) =>
    `  ${label}  ${vec(e.point)}` +
    (locator ? c.dim(` on the surface, ${len(e.offset)} from ${vec(e.given)}${several && e.group ? ` [${e.group}]` : ''}`) : '');
  process.stdout.write(
    [
      c.bold(`polymerge measure  ${fileName}`),
      line('from', a),
      line('to  ', b),
      `  ${c.bold('distance')} ${len(distance)}   Δx ${coord(delta[0])}  Δy ${coord(delta[1])}  Δz ${coord(delta[2])}${unit ? '' : c.dim("  (in the file's units)")}`,
    ].join('\n') + '\n',
  );
  return 0;
}
