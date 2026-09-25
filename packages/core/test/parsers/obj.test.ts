import { describe, expect, it } from 'vitest';
import { loadMesh } from '../../src/parsers/index.js';
import { MeshLoadError } from '../../src/types.js';
import { CUBE_CORNERS, CUBE_EXPECTED_FACES, CUBE_EXPECTED_POSITIONS, CUBE_TRIS, objText, utf8 } from './helpers.js';

describe('OBJ', () => {
  it('triangle cube → same arrays as the STL cube; unnamed object named after the file', async () => {
    const mesh = await loadMesh(utf8(objText(CUBE_CORNERS, CUBE_TRIS)), { fileName: 'cube.obj' });
    expect(Array.from(mesh.positions)).toEqual(CUBE_EXPECTED_POSITIONS);
    expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
    expect(mesh.groups).toEqual([{ name: 'cube', faceStart: 0, faceCount: 12 }]);
    expect(mesh.materials).toEqual([]);
    expect(mesh.faceMaterials).toBeUndefined();
    expect(mesh.metadata).toMatchObject({
      format: 'obj',
      sourceName: 'cube.obj',
      sourceVertexCount: 36, // OBJLoader de-indexes
      sourceFaceCount: 12,
      extras: { materialLibraries: [] },
      warnings: [],
    });
  });

  it('multiple o / g / usemtl: groups in file order, usemtl names as materials, lines & points skipped', async () => {
    const text = [
      'mtllib scene.mtl',
      'v 0 0 0',
      'v 1 0 0',
      'v 1 1 0',
      'v 0 1 0',
      'v 0 0 1',
      'v 1 0 1',
      'o Box',
      'usemtl red',
      'f 1 2 3',
      'f 1 3 4',
      'usemtl blue',
      'f 1 2 6 5', // quad → fan (1 2 6), (1 6 5)
      'g Lid',
      'usemtl red',
      'f 5 6 3',
      'o Empty',
      'o Wire',
      'l 1 2 3',
      'o Tail', // inherits the last material ("red", per OBJLoader)
      'f 4 3 6',
      'o Cloud',
      'p 1 2',
    ].join('\n');
    const mesh = await loadMesh(utf8(text), { fileName: 'scene.obj' });
    expect(mesh.groups).toEqual([
      { name: 'Box', faceStart: 0, faceCount: 4 },
      { name: 'Lid', faceStart: 4, faceCount: 1, materialIndex: 0 },
      { name: 'Tail', faceStart: 5, faceCount: 1, materialIndex: 0 },
    ]);
    expect(mesh.materials).toEqual([{ name: 'red' }, { name: 'blue' }]);
    expect(Array.from(mesh.faceMaterials!)).toEqual([0, 0, 1, 1, 0, 0]);
    expect(Array.from(mesh.faces)).toEqual([0, 1, 2, 0, 2, 3, 0, 1, 4, 0, 4, 5, 5, 4, 2, 3, 2, 4]);
    expect(mesh.metadata.extras).toEqual({ materialLibraries: ['scene.mtl'] });
    expect(mesh.metadata.warnings).toHaveLength(1);
    expect(mesh.metadata.warnings[0]).toMatch(/1 line object\(s\) \("Wire"\) and 1 point object\(s\) \("Cloud"\)/);
  });

  it('faces without usemtl get material -1 next to faces with one', async () => {
    const text = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 0 0 1', 'o plain', 'f 1 2 3', 'o painted', 'usemtl steel', 'f 1 2 4'].join('\n');
    const mesh = await loadMesh(utf8(text), { format: 'obj' });
    expect(mesh.groups).toEqual([
      { name: 'plain', faceStart: 0, faceCount: 1 },
      { name: 'painted', faceStart: 1, faceCount: 1, materialIndex: 0 },
    ]);
    expect(mesh.materials).toEqual([{ name: 'steel' }]);
    expect(Array.from(mesh.faceMaterials!)).toEqual([-1, 0]);
  });

  it('v/vt/vn face syntax, negative indices, n-gons, CRLF and comments', async () => {
    const text = [
      '# quad and pentagon',
      'v 0 0 0',
      'v 1 0 0',
      'v 1 1 0',
      'v 0 1 0',
      'vt 0 0',
      'vn 0 0 1',
      'f 1/1/1 2/1/1 3/1/1 4/1/1',
      'v 2 0 0',
      'v 3 0 0',
      'v 3 1 0',
      'v 2.5 1.5 0',
      'v 2 1 0',
      'f -5//1 -4//1 -3//1 -2//1 -1//1',
    ].join('\r\n');
    const mesh = await loadMesh(utf8(text), { format: 'obj' });
    expect(mesh.faceCount).toBe(2 + 3);
    expect(mesh.vertexCount).toBe(9);
    expect(Array.from(mesh.faces)).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 4, 7, 8]);
  });

  it('degenerate faces are dropped, bad indices are dropped as invalid', async () => {
    const text = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 0 1 0', 'f 1 2 3', 'f 3 4 1', 'f 1 2 99'].join('\n');
    const mesh = await loadMesh(utf8(text), { format: 'obj' });
    expect(mesh.faceCount).toBe(1);
    expect(mesh.metadata.sourceFaceCount).toBe(3);
    expect(mesh.metadata.degenerateFacesDropped).toBe(2);
    expect(mesh.metadata.extras).toMatchObject({ invalidFacesDropped: 1 });
  });

  it('weldEpsilon merges near-duplicate OBJ vertices', async () => {
    const text = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 1.00001 0 0', 'v 1 1 0', 'v 0 1.00001 0', 'f 1 2 3', 'f 4 5 6'].join('\n');
    expect((await loadMesh(utf8(text), { format: 'obj' })).vertexCount).toBe(6);
    const welded = await loadMesh(utf8(text), { format: 'obj', weldEpsilon: 1e-4 });
    expect(welded.vertexCount).toBe(4);
    expect(Array.from(welded.faces)).toEqual([0, 1, 2, 1, 3, 2]);
  });

  it('files without triangle faces → MeshLoadError', async () => {
    await expect(loadMesh(utf8('v 0 0 0\nv 1 0 0\nv 0 1 0\n'), { format: 'obj' })).rejects.toThrow(/no triangle faces/);
    await expect(loadMesh(utf8('v 0 0 0\nv 1 0 0\nl 1 2\n'), { fileName: 'wire.obj' })).rejects.toThrow(
      /wire\.obj: OBJ contains no triangle faces \(1 line object/,
    );
    await expect(loadMesh(utf8('# nothing here\n'), { fileName: 'x.obj' })).rejects.toThrow(MeshLoadError);
  });
});
