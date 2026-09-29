/**
 * glTF / GLB writer: output validated by the Khronos glTF-Validator, exact round trips
 * (glTF → IMesh → glTF → IMesh) with the source's node structure, instancing, baked
 * skin / morph / GPU instances, flat (STL / OBJ) meshes and faces that belong to no node.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/diff/prng.js';
import { createMesh } from '../../src/mesh.js';
import { loadMesh } from '../../src/parsers/index.js';
import type { IMesh } from '../../src/types.js';
import { buildGltfDocument, writeGlb, writeGltf, writeMesh } from '../../src/writers/index.js';
import { asciiStl, buildGltf, CUBE_CORNERS, CUBE_TRIS, cubeTriangles, glbBytes, objText, utf8, type GltfSpec, type NodeSpec, type PrimitiveSpec } from '../parsers/helpers.js';
import { validateGltf } from './validate.js';

type Quat = [number, number, number, number];

function quat(axis: [number, number, number], deg: number): Quat {
  const q = new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), (deg * Math.PI) / 180);
  return [q.x, q.y, q.z, q.w];
}

const cubePrim = (extra: Partial<PrimitiveSpec> = {}): PrimitiveSpec => ({ positions: CUBE_CORNERS.flat(), indices: CUBE_TRIS.flat(), ...extra });

/** A bumpy nx × ny sheet with non-dyadic coordinates, as an indexed primitive. */
function sheetPrim(nx: number, ny: number, extra: Partial<PrimitiveSpec> = {}): PrimitiveSpec {
  const positions: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) positions.push(i * 0.37 - 1.1, j * 0.29 + 0.05, 0.2 * Math.sin(i * 1.3 + j * 0.7));
  const indices: number[] = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      indices.push(a, a + 1, a + nx + 1, a, a + nx + 1, a + nx);
    }
  }
  return { positions, indices, ...extra };
}

/** An assembly: nested TRS and matrix nodes, a multi-primitive mesh with materials, a mesh used by two nodes, ids, an empty node. */
function assembly(): GltfSpec {
  const byMatrix = new Matrix4().compose(new Vector3(-2.5, 0.125, 4.2), new Quaternion(...quat([0.3, -1, 0.2], 71)), new Vector3(0.8, 1.3, 1.1));
  return {
    meshes: [
      { name: 'Body', primitives: [sheetPrim(6, 5, { material: 0 }), cubePrim({ positions: CUBE_CORNERS.flat().map((v) => v * 0.4 + 2), material: 1 })] },
      { name: 'Bolt', primitives: [cubePrim({ vertexIds: CUBE_CORNERS.map((_, i) => i) })] },
      { name: 'Plate', primitives: [sheetPrim(4, 4, { vertexIds: Array.from({ length: 16 }, (_, i) => 100 + i) })] },
    ],
    nodes: [
      { name: 'Assembly', translation: [10.25, -3.1, 7.7], rotation: quat([1, 2, 3], 30), scale: [1.5, 0.75, 2.2], children: [1, 2, 4] },
      { name: 'Body', mesh: 0 },
      { name: 'Bolts', translation: [0.3, 0.1, -0.7], children: [3, 5] },
      { name: 'Bolt A', mesh: 1, translation: [0.1, 0.2, 0.3], rotation: quat([0, 0, 1], 45) },
      { name: 'Empty', translation: [1, 2, 3] },
      { name: 'Bolt B', mesh: 1, matrix: byMatrix.elements.slice() },
      { name: 'Plate', mesh: 2, rotation: quat([1, 0, 0], -90), scale: [0.001, 0.001, 0.001] },
    ],
    materials: [
      { name: 'Steel', pbrMetallicRoughness: { baseColorFactor: [0.6, 0.62, 0.65, 1], metallicFactor: 0.9, roughnessFactor: 0.35 } },
      { name: 'Paint', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.1, 0.05, 0.5], metallicFactor: 0, roughnessFactor: 0.6 } },
    ],
    generator: 'polymerge-tests',
  };
}

const load = (bytes: Uint8Array, name: string): Promise<IMesh> => loadMesh(bytes, { fileName: name });

/** Everything the round trip must preserve, bit for bit. */
function expectSameModel(back: IMesh, m: IMesh): void {
  expect(Array.from(back.positions)).toEqual(Array.from(m.positions));
  expect(Array.from(back.faces)).toEqual(Array.from(m.faces));
  expect(back.groups).toEqual(m.groups);
  expect(back.materials).toEqual(m.materials);
  expect(back.faceMaterials).toEqual(m.faceMaterials);
  expect(back.vertexIds).toEqual(m.vertexIds);
}

/** Zero errors and zero warnings from the Khronos validator; infos may only be NODE_EMPTY (a transform-only node the source had too). */
async function expectValid(bytes: Uint8Array): Promise<void> {
  const v = await validateGltf(bytes);
  expect(v.problems, 'validator errors / warnings').toEqual([]);
  expect([v.errors, v.warnings]).toEqual([0, 0]);
  expect(v.notes.filter((m) => !m.startsWith('NODE_EMPTY')), 'validator infos').toEqual([]);
}

describe('glTF writer — round trip with node structure', () => {
  it('assembly: GLB and .gltf validate and read back identically (positions, faces, groups, materials, ids, scene)', async () => {
    const source = await load(glbBytes(buildGltf(assembly())), 'assembly.glb');
    expect(source.scene!.nodes.map((n) => n.name)).toEqual(['Assembly', 'Body', 'Bolts', 'Bolt A', 'Empty', 'Bolt B', 'Plate']);
    for (const [bytes, name] of [
      [writeGlb(source), 'out.glb'],
      [writeGltf(source), 'out.gltf'],
    ] as const) {
      await expectValid(bytes);
      const back = await load(bytes, name);
      expectSameModel(back, source);
      // Node names, hierarchy, local transforms (as written), mesh links, worlds and face origins.
      expect(back.scene).toEqual(source.scene);
    }
    const doc = buildGltfDocument(source);
    expect(doc.inexactVertices).toBe(0);
    expect(doc.notes).toEqual([]);
    const json = doc.json as { nodes: Record<string, unknown>[]; meshes: { name: string; primitives: unknown[] }[] };
    // The mesh two nodes use is written once; transforms are written exactly as the source had them.
    expect(json.meshes.map((m) => [m.name, m.primitives.length])).toEqual([
      ['Body', 2],
      ['Bolt', 1],
      ['Plate', 1],
    ]);
    expect(json.nodes[3]).toEqual({ name: 'Bolt A', translation: [0.1, 0.2, 0.3], rotation: quat([0, 0, 1], 45), mesh: 1 });
    expect(json.nodes[5].matrix).toEqual(assembly().nodes[5].matrix);
    expect(json.nodes[5].mesh).toBe(1);
    expect(json.nodes[4]).toEqual({ name: 'Empty', translation: [1, 2, 3] });
  });

  it('.gltf is one self-contained JSON file with a base64 data: URI buffer', async () => {
    const source = await load(glbBytes(buildGltf(assembly())), 'assembly.glb');
    const json = JSON.parse(new TextDecoder().decode(writeGltf(source)));
    expect(json.asset).toEqual({ version: '2.0', generator: 'polymerge' });
    expect(json.buffers).toHaveLength(1);
    expect(json.buffers[0].uri).toMatch(/^data:application\/octet-stream;base64,/);
    // No NORMAL (clients compute flat normals), no UVs; positions and the id attribute only.
    const attributes = json.meshes.flatMap((m: { primitives: { attributes: object }[] }) => m.primitives.map((p) => Object.keys(p.attributes).sort().join()));
    expect(new Set(attributes)).toEqual(new Set(['POSITION', 'POSITION,_VERTEX_ID']));
  });

  it('random nested transforms (rotation, non-uniform scale, matrix nodes): float32-exact, no inexact vertex', async () => {
    const rand = mulberry32(20260929);
    const r = (lo: number, hi: number): number => lo + (hi - lo) * rand();
    const nodes: NodeSpec[] = [];
    const meshes: GltfSpec['meshes'] = [];
    for (let i = 0; i < 16; i++) {
      const t: [number, number, number] = [r(-100, 100), r(-100, 100), r(-100, 100)];
      const q = quat([r(-1, 1), r(-1, 1), r(-1, 1) + 1e-3], r(0, 360));
      const s: [number, number, number] = [r(0.1, 10), r(0.1, 10), r(0.1, 10)];
      const node: NodeSpec = { name: `n${i}`, mesh: i };
      if (i % 4 === 3) node.matrix = new Matrix4().compose(new Vector3(...t), new Quaternion(...q), new Vector3(...s)).elements.slice();
      else Object.assign(node, { translation: t, rotation: q, scale: s });
      nodes.push(node);
      if (i > 0) {
        const parent = nodes[Math.floor(rand() * i)];
        parent.children = [...(parent.children ?? []), i];
      }
      const scale = 10 ** r(-2, 2);
      const positions = Array.from({ length: 24 * 3 }, () => Math.fround(r(-1, 1) * scale));
      const indices: number[] = [];
      for (let k = 0; k < 20; k++) indices.push(k, k + 1 + (k % 3), k + 2 + ((k * 7) % 2));
      meshes.push({ name: `m${i}`, primitives: [{ positions, indices }] });
    }
    const source = await load(glbBytes(buildGltf({ meshes, nodes })), 'random.glb');
    const doc = buildGltfDocument(source);
    expect(doc.inexactVertices).toBe(0);
    const bytes = writeGlb(source);
    await expectValid(bytes);
    const back = await load(bytes, 'random.glb');
    expectSameModel(back, source);
    expect(back.scene).toEqual(source.scene);
  });
});

describe('glTF writer — what cannot be kept as it was', () => {
  it('skinned, morphed and GPU-instanced geometry is written as static triangles in its baked shape', async () => {
    const n = CUBE_CORNERS.length;
    const skinned = buildGltf({
      meshes: [
        {
          name: 'Skin',
          primitives: [
            cubePrim({
              attributes: {
                JOINTS_0: { data: new Array(n * 4).fill(0), type: 'VEC4', componentType: 5121 },
                WEIGHTS_0: { data: Array.from({ length: n }, () => [1, 0, 0, 0]).flat(), type: 'VEC4', componentType: 5126 },
              },
            }),
          ],
        },
        { name: 'Morph', weights: [0.5], primitives: [cubePrim({ targets: [CUBE_CORNERS.flatMap(([, , z]) => [0, 0, z * 2])] })] },
        { name: 'Bolt', primitives: [cubePrim()] },
      ],
      nodes: [
        { name: 'Skinned', mesh: 0, skin: 0, translation: [100, 0, 0] },
        { name: 'Joint', translation: [0, 5, 0] },
        { name: 'Morphed', mesh: 1, translation: [0, 0, 20] },
        { name: 'Bolts', mesh: 2, translation: [0, 30, 0], extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: '@accessor:tr' } } } },
      ],
      extraAccessors: {
        ibm: { data: new Matrix4().elements.slice(), type: 'MAT4', componentType: 5126 },
        tr: { data: [0, 0, 0, 10, 0, 0, 0, 0, 3.5], type: 'VEC3', componentType: 5126 },
      },
      extra: { skins: [{ joints: [1], inverseBindMatrices: '@accessor:ibm' }], extensionsUsed: ['EXT_mesh_gpu_instancing'] },
    });
    const source = await load(glbBytes(skinned), 'rig.glb');
    expect(source.scene!.nodes.map((x) => x.baked)).toEqual([['skin'], undefined, ['morph'], ['instances']]);
    const doc = buildGltfDocument(source);
    expect(doc.notes.join('\n')).toMatch(/"Skinned".*static triangles in its posed shape/);
    expect(doc.notes.join('\n')).toMatch(/"Morphed".*default weights applied/);
    expect(doc.notes.join('\n')).toMatch(/"Bolts".*EXT_mesh_gpu_instancing copies were written as plain geometry/);
    const json = doc.json as Record<string, unknown> & { nodes: Record<string, unknown>[]; meshes: Record<string, unknown>[] };
    expect(json.skins).toBeUndefined();
    expect(json.extensionsUsed).toBeUndefined();
    expect(json.nodes[0]).toEqual({ name: 'Skinned', translation: [100, 0, 0], mesh: 0 });
    expect(json.meshes[1]).not.toHaveProperty('weights');
    const bytes = writeGlb(source);
    await expectValid(bytes);
    const back = await load(bytes, 'rig.glb');
    expectSameModel(back, source);
    expect(back.metadata.warnings).toEqual([]); // nothing left to bake
  });

  it('a mesh shared by two nodes is split when a merge edits one instance', async () => {
    const source = await load(glbBytes(buildGltf(assembly())), 'assembly.glb');
    const edited = { ...source, positions: Float64Array.from(source.positions) };
    // Move one vertex of Bolt B's cube (its faces are the group named "Bolt B").
    const g = source.groups.find((x) => x.name === 'Bolt B')!;
    const v = source.faces[g.faceStart * 3];
    edited.positions[v * 3 + 2] += 0.25;
    const doc = buildGltfDocument(edited);
    const json = doc.json as { nodes: { name: string; mesh?: number }[]; meshes: { name: string }[] };
    expect(json.meshes.map((m) => m.name)).toEqual(['Body', 'Bolt', 'Plate', 'Bolt']);
    expect(json.nodes.find((n) => n.name === 'Bolt A')!.mesh).toBe(1);
    expect(json.nodes.find((n) => n.name === 'Bolt B')!.mesh).toBe(3);
    expect(doc.notes.join()).toMatch(/1 instance\(s\) of shared meshes diverged/);
    const bytes = writeGlb(edited);
    await expectValid(bytes);
    expectSameModel(await load(bytes, 'edited.glb'), edited);
  });

  it('faces that belong to no node get a root node per group name, in world space', async () => {
    const source = await load(glbBytes(buildGltf(assembly())), 'assembly.glb');
    const g = source.groups.find((x) => x.name === 'Plate')!;
    const scene = { ...source.scene!, faceSources: Int32Array.from(source.scene!.faceSources) };
    scene.faceSources.fill(-1, g.faceStart, g.faceStart + g.faceCount);
    const loose: IMesh = { ...source, scene };
    const doc = buildGltfDocument(loose);
    expect(doc.notes).toEqual(['18 face(s) belong to no node; written in world space under 1 new root node(s) ("Plate")']);
    const json = doc.json as { nodes: { name: string; mesh?: number }[]; scenes: { nodes: number[] }[] };
    expect(json.nodes).toHaveLength(8);
    expect(json.nodes[6]).toEqual({ name: 'Plate', rotation: source.scene!.nodes[6].rotation, scale: [0.001, 0.001, 0.001] }); // kept, now empty
    expect(json.nodes[7]).toEqual({ name: 'Plate', mesh: 2 });
    expect(json.scenes[0].nodes).toEqual([0, 6, 7]);
    const bytes = writeGlb(loose);
    await expectValid(bytes);
    const back = await load(bytes, 'loose.glb');
    expect(Array.from(back.positions)).toEqual(Array.from(source.positions)); // same stream: the Plate faces were last already
    expect(back.groups.map((x) => x.name)).toEqual(source.groups.map((x) => x.name));
  });

  it('a stale scene (face count mismatch) is ignored with a note', () => {
    const m = createMesh(CUBE_CORNERS.flat(), CUBE_TRIS.flat());
    m.scene = { nodes: [], roots: [], meshes: [], sources: [], faceSources: new Int32Array(3) };
    const doc = buildGltfDocument(m);
    expect(doc.notes).toEqual(['the scene structure does not match the mesh; it was written without it']);
    expect((doc.json as { nodes: unknown[] }).nodes).toHaveLength(1);
  });
});

describe('glTF writer — meshes without a scene (STL / OBJ / merges of them)', () => {
  it('one root node per group, world space; round trip is exact', async () => {
    const obj = await load(utf8(objText([...CUBE_CORNERS, ...CUBE_CORNERS.map(([x, y, z]) => [x + 3, y, z] as [number, number, number])], [...CUBE_TRIS, ...CUBE_TRIS.map((t) => t.map((i) => i + 8))], ['o left']).replace(/^(f 9 .*)$/m, 'o right\n$1')), 'parts.obj');
    expect(obj.groups.map((g) => g.name)).toEqual(['left', 'right']);
    const stl = await load(utf8(asciiStl([{ name: 'cube', tris: cubeTriangles([0.1, 0.2, 0.3]) }])), 'cube.stl');
    for (const [m, names] of [
      [obj, ['left', 'right']],
      [stl, ['cube']],
    ] as const) {
      const bytes = writeMesh(m, 'glb');
      await expectValid(bytes);
      const json = buildGltfDocument(m).json as { nodes: { name: string }[] };
      expect(json.nodes.map((n) => n.name)).toEqual(names);
      const back = await load(bytes, 'flat.glb');
      expect(Array.from(back.positions)).toEqual(Array.from(m.positions));
      expect(Array.from(back.faces)).toEqual(Array.from(m.faces));
      expect(back.groups).toEqual(m.groups);
    }
  });

  it('materials: IMaterial → pbrMetallicRoughness (unknown metalness written as 0)', async () => {
    const m = createMesh(CUBE_CORNERS.flat(), CUBE_TRIS.flat(), {
      materials: [{ name: 'Red', color: [1, 0, 0, 1] }, { name: 'Brass', color: [0.9, 0.7, 0.2, 1], metalness: 1, roughness: 0.3 }],
      faceMaterials: Int32Array.from({ length: 12 }, (_, i) => (i < 6 ? 0 : 1)),
    });
    const json = buildGltfDocument(m).json as { materials: unknown[]; meshes: { primitives: { material?: number }[] }[] };
    expect(json.materials).toEqual([
      { name: 'Red', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 0 } },
      { name: 'Brass', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.7, 0.2, 1], metallicFactor: 1, roughnessFactor: 0.3 } },
    ]);
    expect(json.meshes[0].primitives.map((p) => p.material)).toEqual([0, 1]);
    const bytes = writeGlb(m);
    await expectValid(bytes);
    const back = await load(bytes, 'mat.glb');
    expect(Array.from(back.faceMaterials!)).toEqual(Array.from(m.faceMaterials!));
    expect(back.materials[1]).toEqual({ name: 'Brass', color: [0.9, 0.7, 0.2, 1], metalness: 1, roughness: 0.3 });
  });
});
