/**
 * Scene structure through a three-way merge (merge/structure.ts) and out through the glTF writer:
 * every merged face keeps its node, a side's transform move is carried as a transform, a node a
 * side added comes along, a deleted one goes, and vertex ids survive for Tier 1's ID mode.
 *
 * Geometry and transforms are dyadic, so baked world positions are exact and the written local
 * data can be compared bit for bit.
 */
import { describe, expect, it } from 'vitest';
import { diffMeshes } from '../../src/diff/index.js';
import { mergeMeshes, resolveMerge } from '../../src/merge/index.js';
import { loadMesh } from '../../src/parsers/index.js';
import { groupIndexOfFace } from '../../src/mesh.js';
import type { IMergeResult, IMesh, Vec3 } from '../../src/types.js';
import { buildGltfDocument, writeGlb, writeObj, writeStl, type IGltfDocument } from '../../src/writers/index.js';
import { buildGltf, glbBytes, type GltfSpec, type NodeSpec } from '../parsers/helpers.js';
import { validateGltf } from '../writers/validate.js';
import { silent } from '../diff/util.js';

/** nx × ny sheet, spacing 1/4, heights in eighths: exact under dyadic transforms. */
function sheet(nx: number, ny: number): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) positions.push(i * 0.25, j * 0.25, ((i * 3 + j * 5) % 4) / 8);
  const indices: number[] = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      indices.push(a, a + 1, a + nx + 1, a, a + nx + 1, a + nx);
    }
  }
  return { positions, indices };
}

const CUBE = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1].map((v) => v / 4);
const CUBE_INDICES = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];

interface Variant {
  arm?: Vec3;
  armMoves?: Record<number, Vec3>;
  plateMoves?: Record<number, Vec3>;
  /** A new node "Bracket" (own mesh) under Assembly, between Arm and Plate in the file. */
  bracket?: boolean;
  noBoltB?: boolean;
  noBolts?: boolean;
  /** _VERTEX_ID on Arm (1000 + i) and Plate (2000 + i). */
  ids?: boolean;
  /** An extra triangle on Arm with a new vertex, and its id. */
  armExtra?: number;
  /** An extra triangle on Plate with a new vertex, and its id. */
  plateExtra?: number;
}

/**
 * Assembly (T 1,2,0) ─┬─ Arm (T 0,0,1; mesh Arm)
 *                     ├─ [Bracket (T 0,0,2)]
 *                     ├─ Plate (mesh Plate)
 *                     └─ Bolts (T 2,0,0) ─┬─ Bolt A (T 0,½,0; mesh Bolt)
 *                                         └─ Bolt B (T 0,1½,0; mesh Bolt)
 */
function assembly(v: Variant = {}): GltfSpec {
  const moved = (s: { positions: number[]; indices: number[] }, moves: Record<number, Vec3> = {}) => {
    const positions = [...s.positions];
    for (const [k, d] of Object.entries(moves)) for (let a = 0; a < 3; a++) positions[Number(k) * 3 + a] += d[a];
    return { positions, indices: [...s.indices] };
  };
  const arm = moved(sheet(6, 5), v.armMoves);
  const plate = moved(sheet(5, 5), v.plateMoves);
  const armIds = arm.positions.map((_, i) => 1000 + i).slice(0, arm.positions.length / 3);
  const plateIds = plate.positions.map((_, i) => 2000 + i).slice(0, plate.positions.length / 3);
  if (v.armExtra !== undefined) {
    arm.positions.push(-0.25, 0, 0);
    arm.indices.push(arm.positions.length / 3 - 1, 0, 6);
    armIds.push(v.armExtra);
  }
  if (v.plateExtra !== undefined) {
    plate.positions.push(0, -0.25, 0);
    plate.indices.push(plate.positions.length / 3 - 1, 1, 0);
    plateIds.push(v.plateExtra);
  }
  const meshes: GltfSpec['meshes'] = [
    { name: 'Arm', primitives: [{ ...arm, ...(v.ids ? { vertexIds: armIds } : {}) }] },
    { name: 'Plate', primitives: [{ ...plate, ...(v.ids ? { vertexIds: plateIds } : {}) }] },
  ];
  const nodes: NodeSpec[] = [{ name: 'Assembly', translation: [1, 2, 0], children: [] }];
  const child = (n: NodeSpec): void => {
    nodes[0].children!.push(nodes.length);
    nodes.push(n);
  };
  child({ name: 'Arm', mesh: 0, translation: v.arm ?? [0, 0, 1] });
  if (v.bracket) {
    meshes.push({ name: 'Bracket', primitives: [sheet(3, 3)] });
    child({ name: 'Bracket', mesh: meshes.length - 1, translation: [0, 0, 2] });
  }
  child({ name: 'Plate', mesh: 1 });
  if (!v.noBolts) {
    meshes.push({ name: 'Bolt', primitives: [{ positions: CUBE, indices: CUBE_INDICES }] });
    const bolt = meshes.length - 1;
    const bolts: NodeSpec = { name: 'Bolts', translation: [2, 0, 0], children: [] };
    child(bolts);
    bolts.children!.push(nodes.length);
    nodes.push({ name: 'Bolt A', mesh: bolt, translation: [0, 0.5, 0] });
    if (!v.noBoltB) {
      bolts.children!.push(nodes.length);
      nodes.push({ name: 'Bolt B', mesh: bolt, translation: [0, 1.5, 0] });
    }
  }
  return { meshes, nodes };
}

const load = (bytes: Uint8Array, name: string): Promise<IMesh> => loadMesh(bytes, { fileName: name });
const glb = (v: Variant = {}): Uint8Array => glbBytes(buildGltf(assembly(v)));

async function merge(base: Variant, ours: Variant, theirs: Variant): Promise<IMergeResult> {
  const [b, o, t] = await Promise.all([load(glb(base), 'base.glb'), load(glb(ours), 'ours.glb'), load(glb(theirs), 'theirs.glb')]);
  return mergeMeshes(b, o, t, { logger: silent });
}

/** Node name of every face of a mesh with a scene. */
const faceNodes = (m: IMesh): (string | undefined)[] =>
  Array.from(m.scene!.faceSources, (s) => (s < 0 ? undefined : m.scene!.nodes[m.scene!.sources[s].node].name));

const nodeByName = (m: IMesh, name: string) => m.scene!.nodes.find((n) => n.name === name);

/** The model as a sorted list of faces (float32 corners, winding kept, rotated to a canonical start) with group names. */
function modelKey(m: IMesh, withGroups = true): string[] {
  const out: string[] = [];
  for (let f = 0; f < m.faceCount; f++) {
    const c = [0, 1, 2].map((k) => {
      const v = m.faces[f * 3 + k];
      return [0, 1, 2].map((a) => Math.fround(m.positions[v * 3 + a])).join(',');
    });
    const r = c.indexOf([...c].sort()[0]);
    const group = withGroups ? m.groups[groupIndexOfFace(m, f)].name : '';
    out.push(`${group}|${[c[r], c[(r + 1) % 3], c[(r + 2) % 3]].join('|')}`);
  }
  return out.sort();
}

/** Local positions of a written mesh's primitive (float32), sorted as xyz strings. */
function writtenLocals(doc: IGltfDocument, meshName: string): string[] {
  const json = doc.json as {
    meshes: { name?: string; primitives: { attributes: { POSITION: number } }[] }[];
    accessors: { bufferView: number; count: number }[];
    bufferViews: { byteOffset: number }[];
  };
  const mesh = json.meshes.find((m) => m.name === meshName)!;
  const acc = json.accessors[mesh.primitives[0].attributes.POSITION];
  const data = new Float32Array(doc.bin.buffer, doc.bin.byteOffset + json.bufferViews[acc.bufferView].byteOffset, acc.count * 3);
  const out: string[] = [];
  for (let i = 0; i < acc.count; i++) out.push(`${data[i * 3]},${data[i * 3 + 1]},${data[i * 3 + 2]}`);
  return out.sort();
}

const localsOf = (s: { positions: number[] }): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.positions.length; i += 3) out.push(s.positions.slice(i, i + 3).map((x) => Math.fround(x)).join(','));
  return out.sort();
};

async function writeAndRead(merged: IMesh): Promise<IMesh> {
  const bytes = writeGlb(merged);
  const v = await validateGltf(bytes);
  expect(v.problems, 'validator errors / warnings').toEqual([]);
  return load(bytes, 'merged.glb');
}

describe('scene structure through a merge', () => {
  it('clean merge of edits in two nodes: base structure, every face keeps its node, GLB re-reads to the merged mesh', async () => {
    const r = await merge({}, { armMoves: { 8: [0, 0, 0.25] } }, { plateMoves: { 12: [0, 0, -0.125] } });
    expect(r.clean).toBe(true);
    const base = await load(glb(), 'base.glb');
    const m = r.merged;
    expect(m.scene!.nodes.map((n) => n.name)).toEqual(base.scene!.nodes.map((n) => n.name));
    expect(m.scene!.nodes.map((n) => [n.translation, n.children, n.mesh])).toEqual(base.scene!.nodes.map((n) => [n.translation, n.children, n.mesh]));
    expect(faceNodes(m)).toEqual(faceNodes(base));
    const back = await writeAndRead(m);
    // No additions: the file's face order is the merged order, so the arrays are identical.
    expect(Array.from(back.positions)).toEqual(Array.from(m.positions));
    expect(Array.from(back.faces)).toEqual(Array.from(m.faces));
    expect(back.groups).toEqual(m.groups);
    expect(back.scene!.nodes).toEqual(m.scene!.nodes);
  });

  it("a node ours moved by its transform keeps ours' transform; theirs' local edit on it lands in its local data", async () => {
    const r = await merge({}, { arm: [0.5, 0, 1] }, { armMoves: { 8: [0, 0, 0.25] } });
    expect(r.clean).toBe(true);
    expect(r.stats.partMotionsFromOurs).toBe(1);
    expect(nodeByName(r.merged, 'Arm')!.translation).toEqual([0.5, 0, 1]);
    expect(nodeByName(r.merged, 'Plate')!.translation).toBeUndefined();
    const doc = buildGltfDocument(r.merged);
    expect(doc.inexactVertices).toBe(0);
    // Written local data of Arm = theirs' local data exactly (ours' move is in the transform).
    const theirsArm = assembly({ armMoves: { 8: [0, 0, 0.25] } }).meshes[0].primitives[0];
    expect(writtenLocals(doc, 'Arm')).toEqual(localsOf(theirsArm));
    const back = await writeAndRead(r.merged);
    expect(modelKey(back)).toEqual(modelKey(r.merged));
  });

  it('a part-motion conflict keeps the base transform until resolved; the resolution picks the transform', async () => {
    const r = await merge({}, { arm: [0.5, 0, 1] }, { arm: [0, 0.75, 1] });
    expect(r.conflicts.map((c) => Object.keys(c.kinds))).toEqual([['part-motion']]);
    expect(nodeByName(r.merged, 'Arm')!.translation).toEqual([0, 0, 1]);
    const theirs = resolveMerge(r, { 0: 'theirs' });
    expect(nodeByName(theirs.merged, 'Arm')!.translation).toEqual([0, 0.75, 1]);
    const ours = resolveMerge(r, { 0: 'ours' });
    expect(nodeByName(ours.merged, 'Arm')!.translation).toEqual([0.5, 0, 1]);
    for (const x of [r, theirs, ours]) {
      const doc = buildGltfDocument(x.merged);
      expect(doc.inexactVertices).toBe(0);
      expect(writtenLocals(doc, 'Arm')).toEqual(localsOf(sheet(6, 5))); // the motion is in the transform, never in the data
      expect(modelKey(await writeAndRead(x.merged))).toEqual(modelKey(x.merged));
    }
  });

  it('a node ours added (as a new node, mid-file) comes along under its parent, with its transform', async () => {
    const r = await merge({}, { bracket: true }, { plateMoves: { 3: [0, 0, 0.25] } });
    expect(r.clean).toBe(true);
    expect(r.stats.facesAddedFromOurs).toBe(8);
    const s = r.merged.scene!;
    const bracket = s.nodes.findIndex((n) => n.name === 'Bracket');
    expect(s.nodes[bracket]).toMatchObject({ translation: [0, 0, 2], mesh: s.meshes.findIndex((m) => m.name === 'Bracket') });
    expect(s.nodes[0].children.map((c) => s.nodes[c].name)).toEqual(['Arm', 'Plate', 'Bolts', 'Bracket']);
    expect(faceNodes(r.merged).filter((n) => n === 'Bracket')).toHaveLength(8);
    const back = await writeAndRead(r.merged);
    expect(Array.from(back.positions)).toEqual(Array.from(r.merged.positions)); // appended last: same order
    expect(back.groups.map((g) => g.name)).toEqual(['Arm', 'Plate', 'Bolt A', 'Bolt B', 'Bracket']);
  });

  it('a node ours deleted (with its geometry) is dropped from the merged scene', async () => {
    const r = await merge({}, { noBoltB: true }, { armMoves: { 2: [0, 0, 0.125] } });
    expect(r.clean).toBe(true);
    expect(r.merged.scene!.nodes.map((n) => n.name)).toEqual(['Assembly', 'Arm', 'Plate', 'Bolts', 'Bolt A']);
    const back = await writeAndRead(r.merged);
    expect(back.scene!.nodes.map((n) => n.name)).toEqual(['Assembly', 'Arm', 'Plate', 'Bolts', 'Bolt A']);
    expect(modelKey(back)).toEqual(modelKey(r.merged));
  });

  it("a base that is not glTF (OBJ) takes the structure of ours; base faces find their node through ours' faces", async () => {
    const baseGltf = await load(glb(), 'base.glb');
    const base = await load(writeObj(baseGltf), 'base.obj');
    expect(base.scene).toBeUndefined();
    const ours = await load(glb({ armMoves: { 8: [0, 0, 0.25] } }), 'ours.glb');
    const theirs = await load(glb({ plateMoves: { 12: [0, 0, -0.125] } }), 'theirs.glb');
    const r = mergeMeshes(base, ours, theirs, { logger: silent });
    expect(r.clean).toBe(true);
    expect(r.merged.scene!.nodes.map((n) => n.name)).toEqual(ours.scene!.nodes.map((n) => n.name));
    expect(faceNodes(r.merged)).toEqual(faceNodes(ours));
    const back = await writeAndRead(r.merged);
    expect(modelKey(back, false)).toEqual(modelKey(r.merged, false));
    // Group names now come from ours' nodes, not from the OBJ (which wrote "Bolt_A").
    expect(r.merged.groups.map((g) => g.name)).toEqual(['Arm', 'Plate', 'Bolt_A', 'Bolt_B']);
    expect(back.groups.map((g) => g.name)).toEqual(['Arm', 'Plate', 'Bolt A', 'Bolt B']);
  });

  it('faces an STL side added next to a node join that node (and its primitive)', async () => {
    const base = await load(glb(), 'base.glb');
    // Ours as STL: the same triangles plus one attached to Arm's corner (world (1,2,1)).
    const oursGltf = await load(glb({ armExtra: 0 }), 'ours.glb');
    const ours = await load(writeStl(oursGltf), 'ours.stl');
    const theirs = await load(glb({ plateMoves: { 12: [0, 0, -0.125] } }), 'theirs.glb');
    const r = mergeMeshes(base, ours, theirs, { logger: silent });
    expect(r.clean).toBe(true);
    expect(r.stats.facesAddedFromOurs).toBe(1);
    const nodes = faceNodes(r.merged);
    expect(nodes.every((n) => n !== undefined)).toBe(true);
    expect(nodes[nodes.length - 1]).toBe('Arm');
    const doc = buildGltfDocument(r.merged);
    expect(doc.notes).toEqual([]);
    const back = await writeAndRead(r.merged);
    expect(back.groups.map((g) => [g.name, g.faceCount])).toEqual([
      ['Arm', 41],
      ['Plate', 32],
      ['Bolt A', 12],
      ['Bolt B', 12],
    ]);
  });

  it('vertex ids: carried through the merge (a fresh id where both sides gave a new vertex the same one), written as _VERTEX_ID, Tier 1 ID mode on the merged file', async () => {
    // Both branches added a vertex and gave it the same next free id.
    const r = await merge({ ids: true, noBolts: true }, { ids: true, noBolts: true, armExtra: 1999 }, { ids: true, noBolts: true, plateExtra: 1999 });
    expect(r.clean).toBe(true);
    const ids = r.merged.vertexIds!;
    expect(ids.every((id) => id !== null)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(-2)).toEqual(['1999', '2025']); // theirs' vertex: max id + 1
    const back = await writeAndRead(r.merged);
    const idAt = (m: IMesh): Map<string, string | null> => {
      const out = new Map<string, string | null>();
      for (let v = 0; v < m.vertexCount; v++) out.set(Array.from(m.positions.subarray(v * 3, v * 3 + 3)).join(','), m.vertexIds![v]);
      return out;
    };
    expect(idAt(back)).toEqual(idAt(r.merged));
    // The file orders the added faces into their nodes, so vertex order differs: ID mode matches it anyway.
    const d = diffMeshes(r.merged, back, { logger: silent });
    expect(d.tier).toBe(1);
    expect(d.attempts[0].metrics.idMode).toBe(1);
    expect(d.stats.vertices).toEqual({ unchanged: r.merged.vertexCount, moved: 0, added: 0, removed: 0 });
  });
});
