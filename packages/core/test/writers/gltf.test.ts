/**
 * glTF / GLB writer: output validated by the Khronos glTF-Validator, exact round trips
 * (glTF → IMesh → glTF → IMesh) with the source's node structure, instancing, baked
 * skin / morph / GPU instances, flat (STL / OBJ) meshes and faces that belong to no node.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { remapTextureRefs } from '../../src/appearance.js';
import { mulberry32 } from '../../src/diff/prng.js';
import { createMesh } from '../../src/mesh.js';
import { loadMesh } from '../../src/parsers/index.js';
import type { IMaterialDefinition, IMesh, IMeshAppearance } from '../../src/types.js';
import { buildGltfDocument, writeGlb, writeGltf, writeMesh } from '../../src/writers/index.js';
import { asciiStl, buildGltf, CUBE_CORNERS, CUBE_TRIS, cubeTriangles, glbBytes, objText, utf8, type GltfSpec, type NodeSpec, type PrimitiveSpec } from '../parsers/helpers.js';
import { mergeMeshes, resolveMerge } from '../../src/merge/index.js';
import { appendFaces, def, png, pngImage, sortedFaces, tex, textured as texturedLook, type ILookSpec } from '../merge/appearance-util.js';
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
  if (m.appearance) expectSameAppearance(back, m);
}

/**
 * The appearance layer, exactly: material definitions (texture references compared by the image's
 * content, so image order does not matter), image names / types / URIs / bytes, and every face
 * corner's UVs (a set no face has is not written, so trailing all-NaN sets are ignored).
 */
function expectSameAppearance(back: IMesh, m: IMesh): void {
  const byContent = (look: IMeshAppearance): IMaterialDefinition[] => {
    const hashes = [...new Set(look.images.map((i) => i.hash))].sort();
    return look.materials.map((d) => remapTextureRefs(d, (i) => hashes.indexOf(look.images[i].hash)));
  };
  const images = (look: IMeshAppearance) =>
    look.images.map(({ hash, name, mimeType, uri, data }) => ({ hash, name, mimeType, uri, bytes: data?.length })).sort((a, b) => (a.hash < b.hash ? -1 : 1));
  const uvs = (look: IMeshAppearance): number[][] => {
    const sets = [...look.uvs];
    while (sets.length > 0 && sets[sets.length - 1].every(Number.isNaN)) sets.pop();
    return sets.map((u) => Array.from(u));
  };
  expect(back.appearance, 'appearance read back').toBeDefined();
  expect(byContent(back.appearance!)).toEqual(byContent(m.appearance!));
  expect(images(back.appearance!)).toEqual(images(m.appearance!));
  expect(uvs(back.appearance!)).toEqual(uvs(m.appearance!));
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

// ---- Appearance: materials, textures and per-corner UVs (docs/appearance-merge-design.md §8) -------

const dataUri = (bytes: Uint8Array): string => `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
const uvAttr = (data: number[]) => ({ data, type: 'VEC2' as const, componentType: 5126 });

/**
 * A textured assembly: a panel whose two triangles meet at a UV seam (TEXCOORD_0 and TEXCOORD_1),
 * under a scaled node inside a rotated root, and a box with its own texture. The panel's material
 * uses every texture slot but normal (no tangents are written), a texture transform, MASK alpha,
 * double-siding, two extensions (one with a texture) and extras; the box's is unlit.
 */
function textured(): GltfSpec {
  return {
    meshes: [
      {
        name: 'Panel',
        primitives: [
          {
            positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0],
            attributes: {
              TEXCOORD_0: uvAttr([0, 0, 0.5, 0, 0.5, 0.5, 0.6, 0.1, 1, 0.6, 0.6, 0.6]),
              TEXCOORD_1: uvAttr([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
            },
            material: 0,
          },
        ],
      },
      { name: 'Box', primitives: [cubePrim({ material: 1, attributes: { TEXCOORD_0: uvAttr(CUBE_CORNERS.flatMap(([x, y, z]) => [x * 0.5 + z * 0.25, y * 0.5])) } })] },
    ],
    nodes: [
      { name: 'Root', translation: [1.5, -2, 0.25], rotation: quat([0, 1, 0], 30), children: [1, 2] },
      { name: 'Panel', mesh: 0, scale: [2, 2, 2] },
      { name: 'Box', mesh: 1, translation: [3, 0, 0] },
    ],
    materials: [
      {
        name: 'Painted',
        pbrMetallicRoughness: {
          baseColorFactor: [1, 0.5, 0.25, 1],
          metallicFactor: 0.2,
          roughnessFactor: 0.7,
          baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { offset: [0.5, 0], rotation: 0.25, scale: [2, 2] } } },
          metallicRoughnessTexture: { index: 1 },
        },
        occlusionTexture: { index: 1, texCoord: 1, strength: 0.5 },
        emissiveTexture: { index: 0 },
        emissiveFactor: [0.1, 0.05, 0],
        alphaMode: 'MASK',
        alphaCutoff: 0.3,
        doubleSided: true,
        extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatTexture: { index: 1 } }, KHR_materials_emissive_strength: { emissiveStrength: 2 } },
        extras: { studio: 'A' },
      },
      { name: 'Sticker', pbrMetallicRoughness: { baseColorTexture: { index: 2 } }, extensions: { KHR_materials_unlit: {} } },
    ],
    extra: {
      images: [{ uri: dataUri(png([200, 40, 40])), name: 'albedo' }, { uri: dataUri(png([90, 90, 255])), name: 'orm' }, { uri: dataUri(png([40, 200, 40])) }],
      samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33648, wrapT: 10497 }],
      textures: [{ source: 0, sampler: 0 }, { source: 1, sampler: 0 }, { source: 2 }],
      extensionsUsed: ['KHR_texture_transform', 'KHR_materials_clearcoat', 'KHR_materials_emissive_strength', 'KHR_materials_unlit'],
    },
  };
}

describe('glTF writer — appearance (materials, textures, per-corner UVs)', () => {
  it('a textured assembly: GLB and .gltf validate and read back with the same definitions, images and corner UVs', async () => {
    const source = await load(glbBytes(buildGltf(textured())), 'textured.glb');
    expect(source.appearance!.uvs).toHaveLength(2);
    for (const [bytes, name] of [
      [writeGlb(source), 'out.glb'],
      [writeGltf(source), 'out.gltf'],
    ] as const) {
      await expectValid(bytes);
      const back = await load(bytes, name);
      expectSameModel(back, source);
      expect(back.scene).toEqual(source.scene);
      expect(back.appearance!.materials).toEqual(source.appearance!.materials); // same image order too
    }
    const doc = buildGltfDocument(source);
    expect(doc.notes).toEqual([]);
    const json = doc.json as Record<string, unknown> & {
      images: Record<string, unknown>[];
      samplers: unknown[];
      textures: unknown[];
      meshes: { primitives: { attributes: Record<string, number> }[] }[];
      accessors: { count: number }[];
    };
    // Images are embedded in the buffer with their type; the shared sampler is written once.
    expect(json.images.map((i) => [i.name, i.mimeType, typeof i.bufferView])).toEqual([
      ['albedo', 'image/png', 'number'],
      ['orm', 'image/png', 'number'],
      [undefined, 'image/png', 'number'],
    ]);
    expect(json.samplers).toEqual([{ magFilter: 9729, minFilter: 9987, wrapS: 33648, wrapT: 10497 }]);
    expect(json.textures).toEqual([{ source: 0, sampler: 0 }, { source: 1, sampler: 0 }, { source: 2 }]);
    expect(json.extensionsUsed).toEqual(['KHR_materials_clearcoat', 'KHR_materials_emissive_strength', 'KHR_materials_unlit', 'KHR_texture_transform']);
    // The panel's 4 welded vertices become 5 glTF vertices: vertex 0 sits on both sides of a UV seam
    // (the other shared corner has equal UVs in set 0 but not in set 1, so it splits too: 6 in all).
    const panel = json.meshes[0].primitives[0].attributes;
    expect(Object.keys(panel).sort()).toEqual(['POSITION', 'TEXCOORD_0', 'TEXCOORD_1']);
    expect(source.vertexCount).toBe(4 + 8);
    expect(json.accessors[panel.POSITION].count).toBe(6);
    expect(json.accessors[json.meshes[1].primitives[0].attributes.POSITION].count).toBe(8);
  });

  it('a definition keeps glTF\'s metallic default (1); only an IMaterial with unknown metalness is written as 0', async () => {
    const g = buildGltf({ meshes: [{ primitives: [cubePrim({ material: 0 })] }], nodes: [{ mesh: 0 }], materials: [{ name: 'Default' }] });
    const source = await load(glbBytes(g), 'default.glb');
    expect(source.materials[0]).toEqual({ name: 'Default', color: [1, 1, 1, 1], metalness: 1, roughness: 1 });
    const json = buildGltfDocument(source).json as { materials: unknown[] };
    expect(json.materials).toEqual([{ name: 'Default' }]);
    const back = await load(writeGlb(source), 'default.glb');
    expect(back.materials[0].metalness).toBe(1);
    expect(back.appearance!.materials[0].metallicFactor).toBe(1);
  });

  it('an external image stays a reference (never fetched, never embedded)', async () => {
    const spec = textured();
    (spec.extra!.images as { uri: string }[])[2] = { uri: 'textures/sticker.png' };
    const source = await load(glbBytes(buildGltf(spec)), 'external.glb');
    expect(source.appearance!.images[2]).toEqual({ hash: 'uri:textures/sticker.png', uri: 'textures/sticker.png' });
    const bytes = writeGltf(source);
    const v = await validateGltf(bytes, (uri) => {
      expect(uri).toBe('textures/sticker.png');
      return png([40, 200, 40]);
    });
    expect([v.errors, v.warnings, v.problems, v.notes]).toEqual([0, 0, [], []]);
    expect((JSON.parse(new TextDecoder().decode(bytes)) as { images: unknown[] }).images[2]).toEqual({ uri: 'textures/sticker.png' });
    expectSameModel(await load(bytes, 'external.gltf'), source);
  });

  it('a normal map keeps its scale; its one validator complaint is the tangent space (no normals are written, so clients generate it)', async () => {
    const spec = textured();
    (spec.materials![0] as Record<string, unknown>).normalTexture = { index: 1, scale: 0.8 };
    const source = await load(glbBytes(buildGltf(spec)), 'normal.glb');
    expect(source.appearance!.materials[0].normalTexture).toEqual({ image: 1, texCoord: 0, sampler: { magFilter: 9729, minFilter: 9987, wrapS: 33648, wrapT: 10497 }, scale: 0.8 });
    const bytes = writeGlb(source);
    const v = await validateGltf(bytes);
    expect(v.errors).toBe(0);
    expect(v.problems.map((p) => p.split(' ')[0])).toEqual(['MESH_PRIMITIVE_GENERATED_TANGENT_SPACE']);
    expectSameModel(await load(bytes, 'normal.glb'), source);
  });

  it('a merge of textured models round-trips: every face comes back with its corners, material definition and corner UVs', async () => {
    // Four 2 × 2-quad islands, each in its own cell of texture space; materials sample real PNGs.
    const [albedo, red, redV2, decal] = [pngImage('albedo', [200, 200, 200]), pngImage('red', [220, 20, 20]), pngImage('red v2', [255, 60, 60]), pngImage('decal', [20, 20, 220])];
    const paint = def('Paint', { baseColorTexture: tex(0), roughnessFactor: 0.5 });
    const quadrant = (i: number, j: number): number => (i < 2 ? 0 : 1) + (j < 2 ? 0 : 2);
    const cells: Array<[number, number]> = [
      [0, 0],
      [0.3, 0],
      [0, 0.3],
      [0.3, 0.3],
    ];
    const red1 = def('Red', { baseColorTexture: tex(1) });
    const spec = (moved: Record<number, [number, number]>, over: Partial<ILookSpec>): ILookSpec => ({
      nx: 5,
      ny: 5,
      island: quadrant,
      place: (k) => {
        const [cu, cv] = moved[k] ?? cells[k];
        return [cu - (k % 2 ? 2 : 0) * 0.1, cv - (k >= 2 ? 2 : 0) * 0.1, 0.1];
      },
      materials: [paint, red1],
      images: [albedo, red],
      material: (i, j) => (quadrant(i, j) === 1 ? 1 : 0), // island 1 is red, the rest Paint
      ...over,
    });
    const base = texturedLook(spec({}, {}));
    // Ours: island 0 moved; Paint recoloured and made smoother.
    const ours = texturedLook(spec({ 0: [0.6, 0] }, { materials: [{ ...paint, baseColorFactor: [1, 0.9, 0.8, 1], roughnessFactor: 0.2 }, red1] }));
    // Theirs: island 3 moved, the red texture swapped, Paint recoloured differently (a conflict), and a
    // new decal face (its own material, texture and UVs) below the bottom edge.
    const theirsGrid = texturedLook(spec({ 3: [0.6, 0.6] }, { images: [albedo, redV2], materials: [{ ...paint, baseColorFactor: [0.7, 0.8, 1, 1] }, red1] }));
    // The new face's material is the mesh's own materials (Paint, Red) followed by the extra one: index 2.
    const theirs = appendFaces(theirsGrid, [0.5, -1, 0], [1, 0, 25], [2], [[0.9, 0.9, 0.95, 0.9, 0.9, 0.95]], [def('Decal', { baseColorTexture: tex(2) })]);
    theirs.appearance!.images.push(decal);
    const r = mergeMeshes(base, ours, theirs, { logger: { info() {}, warn() {} } });
    expect(r.conflicts.map((c) => [Object.keys(c.kinds)[0], c.appearance?.properties])).toEqual([['material-property', ['baseColorFactor']]]);
    const merged = resolveMerge(r, { 0: 'theirs' }).merged;
    expect(merged.materials.map((m) => m.name)).toEqual(['Paint', 'Red', 'Decal']);
    for (const [bytes, name] of [
      [writeGlb(merged), 'merged.glb'],
      [writeGltf(merged), 'merged.gltf'],
    ] as const) {
      await expectValid(bytes);
      const back = await load(bytes, name);
      expect(sortedFaces(back)).toEqual(sortedFaces(merged));
      expect(back.materials.map((m) => m.name).sort()).toEqual(['Decal', 'Paint', 'Red']);
    }
    // What was merged is what is written: ours' roughness, theirs' colour, theirs' texture, the decal.
    const back = await load(writeGlb(merged), 'merged.glb');
    const byName = (n: string): IMaterialDefinition => back.appearance!.materials[back.materials.findIndex((m) => m.name === n)];
    expect(byName('Paint')).toMatchObject({ baseColorFactor: [0.7, 0.8, 1, 1], roughnessFactor: 0.2 });
    expect(back.appearance!.images[byName('Red').baseColorTexture!.image].hash).toBe(redV2.hash);
    expect(back.appearance!.images[byName('Decal').baseColorTexture!.image].hash).toBe(decal.hash);
  });

  it('a texture whose only image source is an extension (WebP, no fallback) is written the same way and the extension is required', async () => {
    const webp = new TextEncoder().encode('RIFF....WEBPVP8 fake');
    const g = buildGltf({
      meshes: [{ primitives: [{ positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], attributes: { TEXCOORD_0: uvAttr([0, 0, 1, 0, 1, 1]) }, material: 0 }] }],
      nodes: [{ mesh: 0 }],
      materials: [{ name: 'Web', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      extra: {
        images: [{ uri: `data:image/webp;base64,${btoa(String.fromCharCode(...webp))}` }],
        textures: [{ extensions: { EXT_texture_webp: { source: 0 } } }],
        extensionsUsed: ['EXT_texture_webp'],
        extensionsRequired: ['EXT_texture_webp'],
      },
    });
    const source = await load(glbBytes(g), 'webp.glb');
    expect(source.appearance!.materials[0].baseColorTexture).toEqual({ image: 0, texCoord: 0, sourceExtension: 'EXT_texture_webp' });
    const json = buildGltfDocument(source).json as { textures: unknown[]; images: { mimeType: string }[]; extensionsUsed: string[]; extensionsRequired: string[] };
    expect(json.textures).toEqual([{ extensions: { EXT_texture_webp: { source: 0 } } }]);
    expect(json.images[0].mimeType).toBe('image/webp');
    expect(json.extensionsUsed).toEqual(['EXT_texture_webp']);
    expect(json.extensionsRequired).toEqual(['EXT_texture_webp']);
    expectSameModel(await load(writeGlb(source), 'webp-out.glb'), source);
  });

  it('instances with different UVs do not share a mesh', async () => {
    const spec = assembly();
    spec.meshes[1].primitives[0].attributes = { TEXCOORD_0: uvAttr(CUBE_CORNERS.flatMap(([x, y]) => [x, y])) };
    spec.meshes[1].primitives[0].material = 2;
    spec.materials!.push({ name: 'Decal', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } });
    spec.extra = { images: [{ uri: dataUri(png([10, 20, 30])) }], textures: [{ source: 0 }] };
    const source = await load(glbBytes(buildGltf(spec)), 'bolts.glb');
    // Both bolts share the "Bolt" mesh, UVs included.
    const json0 = buildGltfDocument(source).json as { meshes: { name: string }[] };
    expect(json0.meshes.map((m) => m.name)).toEqual(['Body', 'Bolt', 'Plate']);
    // Re-UV one instance (the faces of Bolt B) only.
    const g = source.groups.find((x) => x.name === 'Bolt B')!;
    const uvs = Float32Array.from(source.appearance!.uvs[0]);
    for (let q = g.faceStart * 6; q < (g.faceStart + g.faceCount) * 6; q += 2) uvs[q] += 0.5;
    const edited: IMesh = { ...source, appearance: { ...source.appearance!, uvs: [uvs] } };
    const doc = buildGltfDocument(edited);
    expect((doc.json as { meshes: { name: string }[] }).meshes.map((m) => m.name)).toEqual(['Body', 'Bolt', 'Plate', 'Bolt']);
    const bytes = writeGlb(edited);
    await expectValid(bytes);
    expectSameModel(await load(bytes, 'bolts.glb'), edited);
  });
});
