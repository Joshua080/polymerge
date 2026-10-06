/**
 * PLY writer (used to save merge results): binary little-endian, float32 x / y / z per vertex and
 * one triangle per face (`uchar` count + `int` indices), which every PLY reader takes. PLY has no
 * groups, so the mesh's groups are not kept; per-face materials with a colour are written as
 * per-face red / green / blue.
 */
import type { IMesh } from '../types.js';

function srgbByte(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

export function writePly(mesh: IMesh, opts: { name?: string } = {}): Uint8Array {
  const colors = mesh.faceMaterials && mesh.materials.some((m) => m.color) ? mesh.materials.map((m) => m.color ?? null) : null;
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `comment written by polymerge${opts.name ? `: ${opts.name.replace(/[\r\n]+/g, ' ')}` : ''}`,
    `element vertex ${mesh.vertexCount}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${mesh.faceCount}`,
    'property list uchar int vertex_indices',
    ...(colors ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
    'end_header',
    '',
  ].join('\n');
  const head = new TextEncoder().encode(header);
  const faceBytes = 13 + (colors ? 3 : 0);
  const out = new Uint8Array(head.length + mesh.vertexCount * 12 + mesh.faceCount * faceBytes);
  out.set(head);
  const view = new DataView(out.buffer);
  let o = head.length;
  const p = mesh.positions;
  for (let i = 0; i < mesh.vertexCount * 3; i++, o += 4) view.setFloat32(o, p[i], true);
  const f = mesh.faces;
  for (let k = 0; k < mesh.faceCount; k++) {
    out[o++] = 3;
    for (let c = 0; c < 3; c++, o += 4) view.setInt32(o, f[k * 3 + c], true);
    if (colors) {
      const color = colors[mesh.faceMaterials![k]] ?? [0.8, 0.8, 0.8, 1];
      out[o++] = srgbByte(color[0]);
      out[o++] = srgbByte(color[1]);
      out[o++] = srgbByte(color[2]);
    }
  }
  return out;
}
