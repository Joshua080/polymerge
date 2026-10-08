import { describe, expect, it } from 'vitest';
import { detectFormat, loadMesh, sniffFormat } from '../../src/parsers/index.js';
import { MeshLoadError, type Vec3 } from '../../src/types.js';
import { writePly } from '../../src/writers/index.js';
import { CUBE_CORNERS, CUBE_EXPECTED_FACES, CUBE_EXPECTED_POSITIONS, CUBE_TRIS, objText, utf8 } from './helpers.js';

function asciiPly(corners: number[][], faces: number[][], extra: { vertexProps?: string[]; vertexValues?: (i: number) => number[]; faceColor?: (f: number) => number[] } = {}): string {
  const lines = ['ply', 'format ascii 1.0', 'comment made by a test', `element vertex ${corners.length}`, 'property float x', 'property float y', 'property float z'];
  for (const p of extra.vertexProps ?? []) lines.push(p);
  lines.push(`element face ${faces.length}`, 'property list uchar int vertex_indices');
  if (extra.faceColor) lines.push('property uchar red', 'property uchar green', 'property uchar blue');
  lines.push('end_header');
  corners.forEach((c, i) => lines.push([...c, ...(extra.vertexValues?.(i) ?? [])].join(' ')));
  faces.forEach((f, i) => lines.push([f.length, ...f, ...(extra.faceColor?.(i) ?? [])].join(' ')));
  return lines.join('\n') + '\n';
}

/** Binary PLY with float x y z and int indices, in either byte order, optionally with an extra element. */
function binaryPly(corners: number[][], faces: number[][], little: boolean, opts: { extraElement?: boolean } = {}): Uint8Array {
  const header = [
    'ply',
    `format binary_${little ? 'little' : 'big'}_endian 1.0`,
    `element vertex ${corners.length}`,
    'property double x',
    'property double y',
    'property double z',
    'property uchar quality',
    ...(opts.extraElement ? ['element edge 1', 'property int vertex1', 'property int vertex2', 'property list uchar ushort tags'] : []),
    `element face ${faces.length}`,
    'property list uchar uint vertex_indices',
    'end_header',
    '',
  ].join('\n');
  const head = utf8(header);
  const size = head.length + corners.length * 25 + (opts.extraElement ? 4 + 4 + 1 + 2 * 2 : 0) + faces.reduce((n, f) => n + 1 + 4 * f.length, 0);
  const out = new Uint8Array(size);
  out.set(head);
  const v = new DataView(out.buffer);
  let o = head.length;
  for (const c of corners) {
    for (const x of c) {
      v.setFloat64(o, x, little);
      o += 8;
    }
    out[o++] = 7;
  }
  if (opts.extraElement) {
    v.setInt32(o, 0, little);
    v.setInt32(o + 4, 1, little);
    out[o + 8] = 2;
    v.setUint16(o + 9, 5, little);
    v.setUint16(o + 11, 6, little);
    o += 13;
  }
  for (const f of faces) {
    out[o++] = f.length;
    for (const i of f) {
      v.setUint32(o, i, little);
      o += 4;
    }
  }
  return out;
}

describe('PLY', () => {
  it('ASCII triangle cube → the same arrays as the STL / OBJ cube', async () => {
    const mesh = await loadMesh(utf8(asciiPly(CUBE_CORNERS, CUBE_TRIS)), { fileName: 'cube.ply' });
    expect(Array.from(mesh.positions)).toEqual(CUBE_EXPECTED_POSITIONS);
    expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
    expect(mesh.groups).toEqual([{ name: 'cube', faceStart: 0, faceCount: 12 }]);
    expect(mesh.metadata).toMatchObject({ format: 'ply', sourceName: 'cube.ply', extras: { ply: { encoding: 'ascii', comments: ['made by a test'], polygons: 12, vertexColors: false } } });
  });

  it('binary little and big endian, double coordinates, extra properties and elements skipped', async () => {
    for (const little of [true, false]) {
      const mesh = await loadMesh(binaryPly(CUBE_CORNERS, CUBE_TRIS, little, { extraElement: true }), { fileName: 'cube.ply' });
      expect(Array.from(mesh.positions)).toEqual(CUBE_EXPECTED_POSITIONS);
      expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
    }
  });

  it('fan-triangulates polygons exactly like the OBJ reader (quads, pentagons)', async () => {
    const corners: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [3, 1, 0],
      [1, 2, 0],
      [-1, 1, 0],
      [0, 0, 1],
    ];
    const polygons = [
      [0, 1, 2, 3, 4], // pentagon
      [0, 1, 5], // triangle
      [1, 2, 5, 0], // quad (not planar, still fanned)
    ];
    const ply = await loadMesh(utf8(asciiPly(corners, polygons)), { fileName: 'p.ply' });
    const obj = await loadMesh(utf8(objText(corners, polygons)), { fileName: 'p.obj' });
    expect(ply.faceCount).toBe(3 + 1 + 2);
    expect(Array.from(ply.positions)).toEqual(Array.from(obj.positions));
    expect(Array.from(ply.faces)).toEqual(Array.from(obj.faces));
  });

  it('per-face colours become materials; per-vertex colours are noted, not kept', async () => {
    const colored = await loadMesh(utf8(asciiPly(CUBE_CORNERS, CUBE_TRIS, { faceColor: (f) => (f < 6 ? [255, 0, 0] : [0, 128, 255]) })), { fileName: 'c.ply' });
    expect(colored.materials.map((m) => m.name)).toEqual(['color_ff0000', 'color_0080ff']);
    expect(colored.materials[0].color).toEqual([1, 0, 0, 1]);
    expect(Array.from(colored.faceMaterials!)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    const vertexColored = await loadMesh(
      utf8(asciiPly(CUBE_CORNERS, CUBE_TRIS, { vertexProps: ['property uchar red', 'property uchar green', 'property uchar blue'], vertexValues: () => [10, 20, 30] })),
      { fileName: 'v.ply' },
    );
    expect(vertexColored.materials).toEqual([]);
    expect(vertexColored.metadata.extras).toMatchObject({ ply: { vertexColors: true } });
    expect(Array.from(vertexColored.faces)).toEqual(CUBE_EXPECTED_FACES);
  });

  it('triangle strips with restarts', async () => {
    const corners = [
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
      [2, 0, 0],
    ];
    const text = [
      'ply',
      'format ascii 1.0',
      'element vertex 5',
      'property float x',
      'property float y',
      'property float z',
      'element tristrips 1',
      'property list int int vertex_indices',
      'end_header',
      ...corners.map((c) => c.join(' ')),
      '7 0 1 2 3 -1 2 4',
    ].join('\n');
    const mesh = await loadMesh(utf8(text), { fileName: 's.ply' });
    // 0 1 2 → (0,1,2); 1 2 3 → flipped (2,1,3); the run after -1 has only 2 corners.
    expect(mesh.faceCount).toBe(2);
  });

  it('is detected by extension and by its magic line', () => {
    const bytes = utf8(asciiPly(CUBE_CORNERS, CUBE_TRIS));
    expect(detectFormat(bytes, 'scan.PLY')).toBe('ply');
    expect(sniffFormat(bytes)).toBe('ply');
    expect(sniffFormat(utf8(asciiPly(CUBE_CORNERS, CUBE_TRIS).replace(/\n/g, '\r\n')))).toBe('ply');
  });

  it('refuses point clouds, truncated bodies and malformed headers with clear messages', async () => {
    const points = asciiPly(CUBE_CORNERS, []).replace('element face 0\nproperty list uchar int vertex_indices\n', '');
    await expect(loadMesh(utf8(points), { fileName: 'pc.ply' })).rejects.toThrow(/point cloud/);
    const truncated = binaryPly(CUBE_CORNERS, CUBE_TRIS, true).subarray(0, 300);
    await expect(loadMesh(truncated, { fileName: 't.ply' })).rejects.toThrow(/shorter than its header/);
    await expect(loadMesh(utf8('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n'), { fileName: 'h.ply' })).rejects.toThrow(/end_header/);
    const err = await loadMesh(utf8('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n'), { fileName: 'x.ply' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeshLoadError);
    expect((err as MeshLoadError).message).toMatch(/x\.ply: .*x, y and z/);
  });

  it('round-trips through the PLY writer (positions exact, colours as per-face RGB)', async () => {
    const source = await loadMesh(utf8(asciiPly(CUBE_CORNERS, CUBE_TRIS, { faceColor: (f) => (f % 2 ? [255, 255, 0] : [0, 0, 255]) })), { fileName: 'c.ply' });
    const back = await loadMesh(writePly(source, { name: 'c' }), { fileName: 'back.ply' });
    expect(Array.from(back.positions)).toEqual(Array.from(source.positions));
    expect(Array.from(back.faces)).toEqual(Array.from(source.faces));
    expect(back.materials.map((m) => m.name)).toEqual(source.materials.map((m) => m.name));
    expect(back.metadata.extras).toMatchObject({ ply: { encoding: 'binary_little_endian', comments: ['written by polymerge: c'] } });
  });
});
