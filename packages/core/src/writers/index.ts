/**
 * Mesh WRITERS (used to save merge results): Wavefront OBJ (keeps groups) and STL (binary or
 * ASCII). Isomorphic: they return bytes; the caller writes files.
 *
 * Numbers are written as the SHORTEST decimal that reads back to the same float32 — every
 * loader stores positions as float32, so this round-trips exactly and keeps files compact.
 */
import type { IMesh, SourceFormat } from '../types.js';
import { groupIndexOfFace } from '../mesh.js';

export type WritableFormat = 'stl' | 'obj';
export const WRITABLE_FORMATS: readonly WritableFormat[] = ['stl', 'obj'];

/** Shortest decimal representation that round-trips through float32. */
export function formatFloat32(x: number): string {
  const f = Math.fround(x);
  if (f === 0) return '0';
  if (!Number.isFinite(f)) throw new RangeError(`cannot write non-finite coordinate ${x}`);
  for (let p = 1; p <= 9; p++) {
    const s = f.toPrecision(p);
    if (Math.fround(Number(s)) === f) return String(Number(s));
  }
  return String(f);
}

export function writeObj(mesh: IMesh, opts: { comment?: string } = {}): Uint8Array {
  const lines: string[] = [];
  lines.push(`# ${opts.comment ?? 'written by polymerge'}`);
  lines.push(`# ${mesh.vertexCount} vertices, ${mesh.faceCount} faces`);
  const p = mesh.positions;
  for (let i = 0; i < mesh.vertexCount; i++) {
    lines.push(`v ${formatFloat32(p[i * 3])} ${formatFloat32(p[i * 3 + 1])} ${formatFloat32(p[i * 3 + 2])}`);
  }
  const f = mesh.faces;
  const named = mesh.groups.length > 1 || (mesh.groups[0] && mesh.groups[0].name !== 'default');
  for (const g of mesh.groups) {
    if (named) lines.push(`o ${g.name.replace(/\s+/g, '_') || 'default'}`);
    for (let k = g.faceStart; k < g.faceStart + g.faceCount; k++) {
      lines.push(`f ${f[k * 3] + 1} ${f[k * 3 + 1] + 1} ${f[k * 3 + 2] + 1}`);
    }
  }
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

function normal(p: Float64Array, a: number, b: number, c: number): [number, number, number] {
  const ux = p[b * 3] - p[a * 3];
  const uy = p[b * 3 + 1] - p[a * 3 + 1];
  const uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3];
  const vy = p[c * 3 + 1] - p[a * 3 + 1];
  const vz = p[c * 3 + 2] - p[a * 3 + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 0];
}

export function writeStl(mesh: IMesh, opts: { binary?: boolean; name?: string } = {}): Uint8Array {
  const p = mesh.positions;
  const f = mesh.faces;
  const name = (opts.name ?? 'polymerge').replace(/\s+/g, '_');
  if (opts.binary === false) {
    const out: string[] = [`solid ${name}`];
    for (let k = 0; k < mesh.faceCount; k++) {
      const [a, b, c] = [f[k * 3], f[k * 3 + 1], f[k * 3 + 2]];
      out.push(`  facet normal ${normal(p, a, b, c).map(formatFloat32).join(' ')}`, '    outer loop');
      for (const v of [a, b, c]) out.push(`      vertex ${formatFloat32(p[v * 3])} ${formatFloat32(p[v * 3 + 1])} ${formatFloat32(p[v * 3 + 2])}`);
      out.push('    endloop', '  endfacet');
    }
    out.push(`endsolid ${name}`);
    return new TextEncoder().encode(out.join('\n') + '\n');
  }
  const buf = new ArrayBuffer(84 + 50 * mesh.faceCount);
  const bytes = new Uint8Array(buf);
  // Header must not start with "solid" (it would look like ASCII STL).
  bytes.set(new TextEncoder().encode(`binary STL written by polymerge: ${name}`.slice(0, 80)));
  const dv = new DataView(buf);
  dv.setUint32(80, mesh.faceCount, true);
  let o = 84;
  for (let k = 0; k < mesh.faceCount; k++) {
    const tri = [f[k * 3], f[k * 3 + 1], f[k * 3 + 2]];
    for (const n of normal(p, tri[0], tri[1], tri[2])) {
      dv.setFloat32(o, n, true);
      o += 4;
    }
    for (const v of tri) {
      for (let a = 0; a < 3; a++) {
        dv.setFloat32(o, p[v * 3 + a], true);
        o += 4;
      }
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return bytes;
}

/** Write a mesh in `format`. GLB/glTF output is not supported yet. */
export function writeMesh(mesh: IMesh, format: SourceFormat, opts: { name?: string; asciiStl?: boolean } = {}): Uint8Array {
  if (format === 'obj') return writeObj(mesh, { comment: opts.name ? `${opts.name} — written by polymerge` : undefined });
  if (format === 'stl') return writeStl(mesh, { binary: !opts.asciiStl, name: opts.name });
  throw new Error(`writing ${format.toUpperCase()} is not supported yet (supported: ${WRITABLE_FORMATS.join(', ')})`);
}

/** Group names in face order (useful for tests / tools). */
export function faceGroupNames(mesh: IMesh): string[] {
  return Array.from({ length: mesh.faceCount }, (_, k) => mesh.groups[groupIndexOfFace(mesh, k)]?.name ?? 'default');
}
