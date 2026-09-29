/**
 * glTF scene capture (IMesh.scene): nodes, local transforms as written, the world matrices the
 * positions were baked with, meshes, and the node + primitive of every face.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { loadMesh } from '../../src/parsers/index.js';
import type { IMesh } from '../../src/types.js';
import { asciiStl, buildGltf, CUBE_CORNERS, CUBE_TRIS, cubeTriangles, glbBytes, gltfText, objText, utf8, type GltfSpec, type PrimitiveSpec } from './helpers.js';

const cubePrim = (extra: Partial<PrimitiveSpec> = {}): PrimitiveSpec => ({ positions: CUBE_CORNERS.flat(), indices: CUBE_TRIS.flat(), ...extra });
const triPrim = (z: number, extra: Partial<PrimitiveSpec> = {}): PrimitiveSpec => ({ positions: [0, 0, z, 1, 0, z, 0, 1, z], ...extra });

async function loadBoth(spec: GltfSpec): Promise<IMesh> {
  const gltf = buildGltf(spec);
  const glb = await loadMesh(glbBytes(gltf), { fileName: 'm.glb' });
  const text = await loadMesh(utf8(gltfText(gltf)), { fileName: 'm.gltf' });
  expect(text.scene).toEqual(glb.scene);
  return glb;
}

/** Per face: [node name, primitive]. */
const faceOrigins = (m: IMesh): [string | undefined, number][] =>
  Array.from(m.scene!.faceSources, (s) => [m.scene!.nodes[m.scene!.sources[s].node].name, m.scene!.sources[s].primitive]);

describe('glTF scene capture', () => {
  it('records the hierarchy, transforms as written, meshes, worlds and face origins', async () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.6);
    const byMatrix = new Matrix4().compose(new Vector3(4, 5, 6), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3), new Vector3(2, 2, 2));
    const mesh = await loadBoth({
      meshes: [
        { name: 'Wheel', primitives: [triPrim(0, { material: 0 }), triPrim(1)] },
        { name: 'Hub', primitives: [cubePrim()] },
      ],
      nodes: [
        { name: 'Car', translation: [1, 2, 3], rotation: [q.x, q.y, q.z, q.w], scale: [1, 1, 0.5], children: [1, 2, 3] },
        { name: 'Front', mesh: 0 },
        { name: 'Hub A', mesh: 1, matrix: byMatrix.elements.slice() },
        { mesh: 1 }, // unnamed: a second user of Hub
      ],
      materials: [{ name: 'Rubber' }],
    });
    const s = mesh.scene!;
    expect(s.roots).toEqual([0]);
    expect(s.meshes).toEqual([{ name: 'Wheel' }, { name: 'Hub' }]);
    expect(s.nodes.map(({ world, ...n }) => n)).toEqual([
      { name: 'Car', children: [1, 2, 3], translation: [1, 2, 3], rotation: [q.x, q.y, q.z, q.w], scale: [1, 1, 0.5] },
      { name: 'Front', children: [], mesh: 0 },
      { name: 'Hub A', children: [], matrix: byMatrix.elements.slice(), mesh: 1 },
      { children: [], mesh: 1 },
    ]);
    // The world matrix is the one the positions were baked with.
    const car = new Matrix4().compose(new Vector3(1, 2, 3), q, new Vector3(1, 1, 0.5));
    for (let i = 0; i < 16; i++) expect(s.nodes[0].world[i]).toBeCloseTo(car.elements[i], 12);
    const hub = new Vector3(...CUBE_CORNERS[0]).applyMatrix4(new Matrix4().multiplyMatrices(car, byMatrix));
    const g = mesh.groups.find((x) => x.name === 'Hub A')!;
    const v = mesh.faces[g.faceStart * 3];
    expect(mesh.positions[v * 3]).toBeCloseTo(hub.x, 5);
    // One source per group; the mesh used by two nodes gives two sources.
    expect(s.sources).toEqual([
      { node: 1, primitive: 0 },
      { node: 1, primitive: 1 },
      { node: 2, primitive: 0 },
      { node: 3, primitive: 0 },
    ]);
    expect(Array.from(s.faceSources)).toEqual([0, 1, ...new Array(12).fill(2), ...new Array(12).fill(3)]);
    expect(faceOrigins(mesh).slice(0, 3)).toEqual([
      ['Front', 0],
      ['Front', 1],
      ['Hub A', 0],
    ]);
  });

  it('only the loaded scene: its nodes in file order, re-indexed densely', async () => {
    const mesh = await loadBoth({
      meshes: [{ primitives: [triPrim(0)] }, { primitives: [triPrim(1)] }],
      nodes: [{ name: 'A', mesh: 0 }, { name: 'Other root' }, { name: 'B', mesh: 1, children: [3] }, { name: 'B child' }],
      scenes: [[0, 1], [2]],
      extra: { scene: 1, scenes: [{ name: 'first', nodes: [0, 1] }, { name: 'second', nodes: [2] }] },
    });
    expect(mesh.scene!.name).toBe('second');
    expect(mesh.scene!.nodes.map((n) => [n.name, n.children, n.mesh])).toEqual([
      ['B', [1], 0],
      ['B child', [], undefined],
    ]);
    expect(mesh.scene!.roots).toEqual([0]);
    expect(mesh.scene!.meshes).toEqual([{}]);
  });

  it('face origins survive primitives that produce no face (all degenerate, points, lines)', async () => {
    const mesh = await loadBoth({
      meshes: [
        {
          name: 'Mixed',
          primitives: [
            { positions: [0, 0, 0, 0, 0, 0, 1, 1, 1] }, // degenerate: welded corners coincide
            triPrim(1, { mode: 0 }), // points
            triPrim(2),
            triPrim(3),
          ],
        },
      ],
      nodes: [{ name: 'N', mesh: 0 }],
    });
    expect(mesh.groups.map((g) => g.faceCount)).toEqual([1, 1]);
    expect(mesh.scene!.sources).toEqual([
      { node: 0, primitive: 2 },
      { node: 0, primitive: 3 },
    ]);
    expect(Array.from(mesh.scene!.faceSources)).toEqual([0, 1]);
  });

  it('STL, OBJ and glTF without a scene carry no structure', async () => {
    const stl = await loadMesh(utf8(asciiStl([{ name: 'c', tris: cubeTriangles() }])), { fileName: 'c.stl' });
    const obj = await loadMesh(utf8(objText(CUBE_CORNERS, CUBE_TRIS)), { fileName: 'c.obj' });
    const noScene = buildGltf({ meshes: [{ primitives: [cubePrim()] }], nodes: [{ mesh: 0 }] });
    delete noScene.json.scene;
    delete noScene.json.scenes;
    const loose = await loadMesh(glbBytes(noScene), { fileName: 'n.glb' });
    for (const m of [stl, obj, loose]) expect('scene' in m).toBe(false);
  });
});
