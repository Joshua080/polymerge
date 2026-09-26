/**
 * Fixture case definitions.
 *
 * Each case constructs a base and a target file from keyed meshes (kmesh.ts),
 * computes the normalised (welded) meshes exactly as the contract prescribes
 * (reference.ts), derives the expected diff from the logical keys, and ALSO checks
 * the result against numbers derived by hand from the construction (assertHand).
 * If the two derivations ever disagree, generation fails.
 *
 * Pure: no file-system access. `buildFixtures()` returns every file's bytes.
 */
import type { IFixtureCase, IFixtureExpectation, IFixtureManifest, MatchTier, Vec3 } from '../../packages/core/src/types.js';
import { box, cylinder, grid, gridKey, gridQuadFace, lBracket, subdividedBox } from './builders.js';
import {
  ObjBuilder,
  fileExtension,
  objFromMesh,
  primitiveFromMesh,
  stlFromMesh,
  triangleStream,
  type CornerTri,
  type FileDoc,
  type GltfDoc,
  type StlDoc,
} from './documents.js';
import {
  MeshBuilder,
  appendMesh,
  facesTouching,
  mapPositions,
  moveVertices,
  removeFaces,
  reorderFaces,
  rotateCorners,
  valences,
  type KMesh,
} from './kmesh.js';
import { applyMat4, boundsDiagonal, composeTRS, covarianceEigenvalues, normalize, pointTriangleDistance, quatFromAxisAngle, type Quat } from './math.js';
import { permutation, randomInts } from './prng.js';
import {
  exactPositionMatches,
  identityIndexFaceAgreement,
  maxSurfaceDistance,
  referenceDiff,
  weld,
  type ReferenceDiff,
  type WeldedMesh,
} from './reference.js';
import { writeFile } from './writers.js';

export interface PreparedFile {
  doc: FileDoc;
  welded: WeldedMesh;
  sourceTriangles: number;
}

export interface BuiltCase {
  fixture: IFixtureCase;
  base: PreparedFile & { bytes: Uint8Array };
  target: PreparedFile & { bytes: Uint8Array };
}

export interface BuiltFixtures {
  manifest: IFixtureManifest;
  cases: BuiltCase[];
  /** Every generated file, keyed by its path relative to fixtures/ (incl. manifest.json). */
  files: Map<string, Uint8Array>;
}

interface CaseDraft {
  id: string;
  title: string;
  description: string;
  base: PreparedFile;
  target: PreparedFile;
  expect: IFixtureExpectation;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function prepare(doc: FileDoc): PreparedFile {
  const stream = triangleStream(doc);
  return { doc, welded: weld(stream), sourceTriangles: stream.length };
}

function assertHand(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`hand-derived check failed for ${label}: construction gives ${a}, hand derivation says ${e}`);
}

function size(w: WeldedMesh): { vertexCount: number; faceCount: number } {
  return { vertexCount: w.positions.length, faceCount: w.faces.length };
}

function exactExpect(tiers: MatchTier[], base: PreparedFile, target: PreparedFile, ref: ReferenceDiff): IFixtureExpectation {
  return {
    acceptableTiers: tiers,
    vertices: { ...ref.stats.vertices },
    faces: { ...ref.stats.faces },
    baseMesh: size(base.welded),
    targetMesh: size(target.welded),
    mustMatch: ref.pairs,
  };
}

/** For closed genus-0 surfaces: V − E + F = 2 with E = 3F/2  ⇒  V = 2 + F/2. */
function assertGenus0(label: string, w: WeldedMesh): void {
  assertHand(`${label} Euler characteristic`, w.positions.length, 2 + w.faces.length / 2);
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

function round(x: number, digits = 4): number {
  return Number(x.toPrecision(digits));
}

/** Sum of the `k` largest valences — the most faces `k` vertices can touch. */
function topValenceSum(w: WeldedMesh, k: number, exclude: (i: number) => boolean = () => false): number {
  const v = new Array<number>(w.positions.length).fill(0);
  for (const f of w.faces) for (const i of f) v[i]++;
  return v
    .filter((_, i) => !exclude(i))
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((a, b) => a + b, 0);
}

function stl(m: KMesh, encoding: 'ascii' | 'binary', id: string, side: string, solidName = id): StlDoc {
  return stlFromMesh(m, encoding, solidName, `polymerge fixture ${id} (${side}), binary STL`);
}

function obj(m: KMesh, id: string, side: string, vertexPerm?: readonly number[]): FileDoc {
  return objFromMesh(m, [`polymerge fixture: ${id} (${side})`], vertexPerm);
}

function singleMeshGltf(m: KMesh, container: 'glb' | 'gltf', opts: {
  name: string;
  translation?: Vec3;
  rotation?: Quat;
  scale?: Vec3;
  primitive?: Parameters<typeof primitiveFromMesh>[1];
}): GltfDoc {
  return {
    kind: 'gltf',
    container,
    sceneName: 'fixture',
    sceneNodes: [0],
    nodes: [{ name: opts.name, mesh: 0, translation: opts.translation, rotation: opts.rotation, scale: opts.scale }],
    meshes: [{ name: opts.name, primitives: [primitiveFromMesh(m, opts.primitive)] }],
    materials: [],
  };
}

function quadFaces(nx: number, quads: Array<[number, number]>): Set<number> {
  const s = new Set<number>();
  for (const [i, j] of quads) {
    const f = gridQuadFace(nx, i, j);
    s.add(f);
    s.add(f + 1);
  }
  return s;
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

function block(is: number[], js: number[]): Array<[number, number]> {
  return js.flatMap((j) => is.map((i) => [i, j] as [number, number]));
}

// ---------------------------------------------------------------------------
// Tier 1 cases
// ---------------------------------------------------------------------------

function identicalCube(): CaseDraft {
  const id = 'identical-cube';
  const cube = box([0, 0, 0], [1, 1, 1]);
  const base = prepare(stl(cube, 'binary', id, 'base'));
  const target = prepare(stl(cube, 'binary', id, 'target'));
  const ref = referenceDiff(base.welded, target.welded);
  assertHand(`${id} sizes`, [size(base.welded), size(target.welded)], [
    { vertexCount: 8, faceCount: 12 },
    { vertexCount: 8, faceCount: 12 },
  ]);
  assertHand(`${id} stats`, ref.stats.vertices, { unchanged: 8, moved: 0, added: 0, removed: 0 });
  assertHand(`${id} faces`, ref.stats.faces, { unchanged: 12, modified: 0, added: 0, removed: 0 });
  assertHand(`${id} identity`, ref.pairs.every(([b, t]) => b === t), true);
  return {
    id,
    title: 'Identical unit cube (binary STL ↔ binary STL)',
    description:
      'The same unit cube [0,1]³ (8 corners, 6 faces × 2 triangles) written twice as binary STL with the same triangle ' +
      'order; only the 80-byte header text differs. Welding (exact float32, first-appearance order) gives 8 vertices / 12 ' +
      'faces on both sides with identical indices, so the index correspondence is the identity and every vertex and face ' +
      'is Unchanged. Expected: Tier 1.',
    base,
    target,
    expect: exactExpect([1], base, target, ref),
  };
}

function cubeMovedCorner(): CaseDraft {
  const id = 'cube-moved-corner';
  const cube = box([0, 0, 0], [1, 1, 1]);
  const cornerKey = 'c:1,0,1';
  const moved = moveVertices(cube, [cornerKey], [0, 0, 0.5]);
  const base = prepare(stl(cube, 'ascii', id, 'base', 'cube'));
  const target = prepare(stl(moved, 'binary', id, 'target'));
  const ref = referenceDiff(base.welded, target.welded);
  // Per-side incidence of the corner: cube face q (emission order +x −x +y −y +z −z) = triangles 2q, 2q+1.
  const names = ['+x', '−x', '+y', '−y', '+z', '−z'];
  const ci = cube.keys.indexOf(cornerKey);
  const perSide = names
    .map((n, q) => [n, [cube.faces[2 * q], cube.faces[2 * q + 1]].filter((f) => f.includes(ci)).length] as const)
    .filter(([, c]) => c > 0);
  const incident = facesTouching(cube, [cornerKey]);
  // Hand derivation: (1,0,1) is corner c01 of the +x quad (in 1 of its 2 triangles), corner c11 of the −y quad
  // (on the split diagonal → both triangles) and corner c10 of the +z quad (1 triangle): 1 + 2 + 1 = 4.
  assertHand(`${id} incidence`, perSide, [
    ['+x', 1],
    ['−y', 2],
    ['+z', 1],
  ]);
  assertHand(`${id} incident`, incident, 4);
  assertHand(`${id} vertices`, ref.stats.vertices, { unchanged: 7, moved: 1, added: 0, removed: 0 });
  assertHand(`${id} faces`, ref.stats.faces, { unchanged: 8, modified: 4, added: 0, removed: 0 });
  assertHand(`${id} identity`, ref.pairs.length === 8 && ref.pairs.every(([b, t]) => b === t), true);
  return {
    id,
    title: 'Unit cube with one corner raised (ASCII STL ↔ binary STL)',
    description:
      'Base: unit cube [0,1]³ as ASCII STL. Target: the same triangles in the same order as binary STL, with corner ' +
      '(1,0,1) moved +0.5 in z to (1,0,1.5). Same face order ⇒ same welded indices (the moved position coincides with no ' +
      'other vertex), so Tier 1 matches by index: 7 vertices Unchanged, 1 Moved (displacement 0.5). Each cube side is a quad ' +
      'split along its c00–c11 diagonal; the corner is c01 of the +x quad (1 triangle), c11 of the −y quad (both triangles) ' +
      'and c10 of the +z quad (1 triangle), so exactly 4 triangles are Modified and the other 8 are Unchanged. mustMatch is ' +
      'the identity on all 8 vertices.',
    base,
    target,
    expect: exactExpect([1], base, target, ref),
  };
}

function gridBump(): CaseDraft {
  const id = 'grid-bump';
  const g = grid(10, 10);
  const bumpKeys = block([4, 5, 6], [4, 5, 6]).map(([i, j]) => gridKey(i, j));
  const bumped = moveVertices(g, bumpKeys, [0, 0, 0.5]);
  const base = prepare(obj(g, id, 'base'));
  const target = prepare(obj(bumped, id, 'target'));
  const ref = referenceDiff(base.welded, target.welded);
  // Hand derivation of modified faces: the quads touching the 3×3 block are i,j ∈ 3..6 (16 quads).
  // Every triangle holds 3 of its quad's 4 corners, so a quad with ≥ 2 raised corners has both triangles modified:
  // 4 inner quads (i,j ∈ 4..5) + 8 edge quads = 12 quads = 24 triangles. Corner quads have 1 raised corner:
  // quad(3,3) → raised v11, quad(6,6) → raised v00 (both on the v00–v11 diagonal: 2 triangles each);
  // quad(6,3) → raised v01, quad(3,6) → raised v10 (1 triangle each). Total 24 + 2 + 2 + 1 + 1 = 30.
  assertHand(`${id} sizes`, size(base.welded), { vertexCount: 121, faceCount: 200 });
  assertHand(`${id} vertices`, ref.stats.vertices, { unchanged: 112, moved: 9, added: 0, removed: 0 });
  assertHand(`${id} faces`, ref.stats.faces, { unchanged: 170, modified: 30, added: 0, removed: 0 });
  assertHand(`${id} identity`, ref.pairs.every(([b, t]) => b === t), true);
  return {
    id,
    title: '10×10 grid with a raised 3×3 block (OBJ ↔ OBJ)',
    description:
      'A flat 10×10-quad grid (spacing 1, 121 vertices, 200 triangles; every quad split along its (i,j)–(i+1,j+1) ' +
      'diagonal), written as OBJ with identical face order on both sides. In the target the interior 3×3 block of vertices ' +
      'i,j ∈ {4,5,6} is raised by +0.5 z. Same face order ⇒ same welded indices ⇒ Tier 1: 9 Moved, 112 Unchanged. ' +
      'Modified faces = triangles touching the block: the 16 quads with i,j ∈ 3..6 give 12 quads with ≥ 2 raised corners ' +
      '(both triangles, 24), the corner quads (3,3) and (6,6) whose raised corner lies on the split diagonal (2 each) and ' +
      '(6,3), (3,6) whose raised corner does not (1 each): 30 Modified, 170 Unchanged.',
    base,
    target,
    expect: exactExpect([1], base, target, ref),
  };
}

function crossFormatStlObj(): CaseDraft {
  const id = 'cross-format-identical';
  const solid = lBracket();
  const base = prepare(stl(solid, 'binary', id, 'base'));
  const target = prepare(obj(solid, id, 'target'));
  const ref = referenceDiff(base.welded, target.welded);
  assertGenus0(id, base.welded);
  assertHand(`${id} all unchanged`, ref.stats.vertices.unchanged === base.welded.positions.length && ref.stats.faces.unchanged === base.welded.faces.length, true);
  assertHand(`${id} identity`, ref.pairs.every(([b, t]) => b === t), true);
  const { vertexCount: v, faceCount: f } = size(base.welded);
  return {
    id,
    title: 'Same solid as binary STL and OBJ',
    description:
      `The asymmetric L-bracket solid (12 unit cells: 4×2×1 plate with a notch, 1×2×2 upright, one tab; integer ` +
      `coordinates, closed genus-0 surface, ${v} vertices / ${f} triangles, V = 2 + F/2) written as binary STL (triangle ` +
      `soup) and as indexed OBJ with the same triangle and corner order. Welding the STL soup by exact float32 equality ` +
      `recovers exactly the OBJ vertex set in the same first-appearance order, so both normalise to the identical IMesh ` +
      `and Tier 1 must report everything Unchanged.`,
    base,
    target,
    expect: exactExpect([1], base, target, ref),
  };
}

function crossFormatObjGlb(): CaseDraft {
  const id = 'cross-format-identical-obj-glb';
  const cyl = cylinder(16, { radius: 1.5, z0: 0, z1: 2.5 });
  const base = prepare(obj(cyl, id, 'base'));
  const target = prepare(
    singleMeshGltf(cyl, 'glb', { name: 'cylinder16', primitive: { vertexOrder: permutation(cyl.positions.length, 0x0b1e) } }),
  );
  const ref = referenceDiff(base.welded, target.welded);
  assertHand(`${id} sizes`, [size(base.welded), size(target.welded)], [
    { vertexCount: 34, faceCount: 64 },
    { vertexCount: 34, faceCount: 64 },
  ]);
  assertHand(`${id} all unchanged`, ref.stats.vertices.unchanged === 34 && ref.stats.faces.unchanged === 64, true);
  assertHand(`${id} identity`, ref.pairs.every(([b, t]) => b === t), true);
  return {
    id,
    title: '16-segment cylinder as OBJ and as GLB with a shuffled vertex buffer',
    description:
      'A closed 16-gon prism (r = 1.5, z ∈ [0, 2.5], 34 vertices, 64 triangles; ring coordinates are float32-rounded ' +
      'cos/sin values, i.e. NOT dyadic) as OBJ, and as GLB whose POSITION buffer is stored in a deterministic shuffled ' +
      'order (indices remapped) but with the same triangle and corner order. OBJ text is written with round-trip-exact ' +
      'float32 digits, so both files carry bit-identical float32 positions; the welded vertex order depends only on the ' +
      'triangle stream, not on buffer order, so both normalise to the same IMesh. Expected: Tier 1, all Unchanged.',
    base,
    target,
    expect: exactExpect([1], base, target, ref),
  };
}

function gltfEmbeddedVsGlb(): CaseDraft {
  const id = 'gltf-embedded-vs-glb';
  const cyl = cylinder(12, { radius: 1, z0: -0.5, z1: 0.75 });
  const node = { name: 'column', translation: [0.5, -0.25, 1] as Vec3, rotation: [0, 1, 0, 0] as Quat, scale: [2, 2, 2] as Vec3 };
  const base = prepare(singleMeshGltf(cyl, 'gltf', node));
  const target = prepare(singleMeshGltf(cyl, 'glb', node));
  const ref = referenceDiff(base.welded, target.welded);
  assertHand(`${id} sizes`, size(base.welded), { vertexCount: 26, faceCount: 48 });
  assertHand(`${id} all unchanged`, ref.stats.vertices.unchanged === 26 && ref.stats.faces.unchanged === 48, true);
  return {
    id,
    title: 'Same glTF as .gltf (base64 data: URI) and as .glb',
    description:
      'One node (translation (0.5, −0.25, 1), rotation 180° about y, uniform scale 2) with a 12-segment closed prism ' +
      '(26 vertices, 48 triangles), serialised once as JSON .gltf with the binary buffer embedded as a base64 ' +
      'data:application/octet-stream URI and once as a binary .glb container. The glTF JSON is identical apart from the ' +
      'buffer uri, so after baking the node transform both normalise to the same IMesh. Expected: Tier 1, all Unchanged. ' +
      '(Exercises the .gltf data-URI path, which GLTFLoader cannot fetch under Node.)',
    base,
    target,
    expect: exactExpect([1], base, target, ref),
  };
}

function glbVertexIds(): CaseDraft {
  const id = 'glb-vertex-ids';
  const g = grid(5, 5, { height: (i, j) => 0.25 * ((i * i + 2 * j) % 3), prefix: 'h:' });
  const idPerm = permutation(g.positions.length, 0x1d5);
  const idOf = new Map(g.keys.map((k, i) => [k, 7001 + 3 * idPerm[i]]));
  const movedKey = gridKey(2, 3, 'h:');
  const edited = moveVertices(g, [movedKey], [0, 0, 0.25]);
  const faceOrder = permutation(edited.faces.length, 0x1d6);
  const shuffled = rotateCorners(reorderFaces(edited, faceOrder), randomInts(edited.faces.length, 3, 0x1d7));
  const base = prepare(singleMeshGltf(g, 'glb', { name: 'terrain', primitive: { vertexIds: (k) => idOf.get(k)! } }));
  const target = prepare(
    singleMeshGltf(shuffled, 'glb', {
      name: 'terrain',
      primitive: { vertexIds: (k) => idOf.get(k)!, vertexOrder: permutation(shuffled.positions.length, 0x1d8) },
    }),
  );
  const ref = referenceDiff(base.welded, target.welded);
  const identityPairs = ref.pairs.filter(([b, t]) => b === t).length;
  // Hand: interior vertex (2,3) is v11 of quad (1,2) [2 tris], v01 of quad (2,2) [1], v10 of quad (1,3) [1], v00 of quad (2,3) [2] → 6.
  assertHand(`${id} sizes`, size(target.welded), { vertexCount: 36, faceCount: 50 });
  assertHand(`${id} vertices`, ref.stats.vertices, { unchanged: 35, moved: 1, added: 0, removed: 0 });
  assertHand(`${id} faces`, ref.stats.faces, { unchanged: 44, modified: 6, added: 0, removed: 0 });
  return {
    id,
    title: 'GLB ↔ GLB matched through the _VERTEX_ID attribute',
    description:
      'A 5×5-quad height-field grid (36 vertices, 50 triangles, z ∈ {0, 0.25, 0.5}) whose primitive carries a custom ' +
      '_VERTEX_ID SCALAR FLOAT attribute (unique integers 7001 + 3·k in a shuffled assignment). In the target the ' +
      'triangle order is shuffled, each triangle\'s corners are cyclically rotated (winding kept), the vertex buffer is ' +
      'stored in a different shuffled order with every id carried along with its vertex, and vertex (2,3) is moved ' +
      `+0.25 z. The welded index orders therefore disagree (only ${identityPairs} of 36 base indices keep their index), so ` +
      'only the ids give the correspondence: Tier 1 in ID mode. Moved: 1; Modified faces: the 6 triangles around ' +
      'interior vertex (2,3); mustMatch lists all 36 pairs, each computed by pushing the ids through each file\'s ' +
      'welding order.',
    base,
    target,
    expect: exactExpect([1], base, target, ref),
  };
}

function gltfMultiNode(): CaseDraft {
  const id = 'gltf-multi-node';
  const cube = box([-0.375, -0.375, -0.375], [0.375, 0.375, 0.375], 'q:');
  const doc = (bx: number): GltfDoc => ({
    kind: 'gltf',
    container: 'glb',
    sceneName: 'two-cubes',
    sceneNodes: [0, 1],
    nodes: [
      { name: 'A', mesh: 0, translation: [-1.5, 0, 0], keyPrefix: 'A/' },
      { name: 'B', mesh: 0, translation: [bx, 0.25, -0.5], keyPrefix: 'B/' },
    ],
    meshes: [{ name: 'cube', primitives: [primitiveFromMesh(cube)] }],
    materials: [],
  });
  const base = prepare(doc(1.5));
  const target = prepare(doc(2.5));
  const ref = referenceDiff(base.welded, target.welded);
  assertHand(`${id} sizes`, size(target.welded), { vertexCount: 16, faceCount: 24 });
  assertHand(`${id} vertices`, ref.stats.vertices, { unchanged: 8, moved: 8, added: 0, removed: 0 });
  assertHand(`${id} faces`, ref.stats.faces, { unchanged: 12, modified: 12, added: 0, removed: 0 });
  assertHand(`${id} identity`, ref.pairs.every(([b, t]) => b === t), true);
  assertHand(`${id} B moved by 1`, ref.displacement.filter((d) => d > 0), new Array(8).fill(1));
  return {
    id,
    title: 'Two instanced cube nodes; node B translated +1 x (GLB ↔ GLB)',
    description:
      'One cube mesh (edge 0.75, centred on its origin, 8 vertices / 12 triangles) instanced by two scene nodes: A at ' +
      'translation (−1.5, 0, 0) and B at (1.5, 0.25, −0.5). In the target only node B\'s translation changes, to ' +
      '(2.5, 0.25, −0.5); the vertex data is byte-identical. After baking world transforms (traversal order A then B) ' +
      'both files weld to 16 vertices / 24 triangles with identical indices (the cubes never touch, before or after). ' +
      'Tier 1: A\'s 8 vertices Unchanged, B\'s 8 Moved by exactly 1.0; A\'s 12 faces Unchanged, B\'s 12 Modified. A parser ' +
      'that ignores node transforms would see the two cubes on top of each other (and weld them) — this case catches it.',
    base,
    target,
    expect: exactExpect([1], base, target, ref),
  };
}

function degenerateTriangles(): CaseDraft {
  const id = 'degenerate-triangles';
  const cube = box([-1, -1, -1], [1, 1, 1], 'd:');
  const clean = stl(cube, 'binary', id, 'base', 'cube');
  const soup = stlFromMesh(cube, 'ascii', 'cube_with_degenerates', '');
  const t0 = soup.triangles[0];
  const withDegenerates: CornerTri[] = [
    ...soup.triangles.slice(0, 4),
    [t0[0], t0[0], t0[1]], // two identical corners (both already seen)
    ...soup.triangles.slice(4),
    [t0[2], t0[2], t0[2]], // fully collapsed
  ];
  const target = prepare({ ...soup, triangles: withDegenerates });
  const base = prepare(clean);
  const ref = referenceDiff(base.welded, target.welded);
  assertHand(`${id} target source/degenerate`, [target.sourceTriangles, target.welded.degenerateDropped], [14, 2]);
  assertHand(`${id} sizes`, [size(base.welded), size(target.welded)], [
    { vertexCount: 8, faceCount: 12 },
    { vertexCount: 8, faceCount: 12 },
  ]);
  assertHand(`${id} identity`, ref.pairs.every(([b, t]) => b === t) && ref.stats.faces.unchanged === 12, true);
  return {
    id,
    title: 'Cube vs the same cube plus two degenerate triangles (binary STL ↔ ASCII STL)',
    description:
      'Base: cube [−1,1]³ as binary STL (12 triangles). Target: the same 12 triangles in the same order as ASCII STL, ' +
      'with two zero-area triangles inserted — (a,a,b) after the 4th facet and (c,c,c) at the end, where a, b, c are ' +
      'corners of the first facet (so they introduce no new vertex and cannot perturb the first-appearance order). The ' +
      'loader delivers 14 triangles; normalisation step 5 drops the 2 whose welded corners are not distinct, leaving ' +
      '8 vertices / 12 faces identical to the base. Expected: Tier 1, all Unchanged.',
    base,
    target,
    expect: exactExpect([1], base, target, ref),
  };
}

function gltfNodeHierarchy(): CaseDraft {
  const id = 'gltf-node-hierarchy';
  const world = lBracket();
  // parent P: T(1,2,3) · R(180° about z) · S(2); child C: T(0.5, 0, −0.25). World = P · C.
  // Local coordinates: p_local = R⁻¹(p_world − t_P)/2 − t_C, with R = diag(−1,−1,1) (all dyadic, exact).
  const tP: Vec3 = [1, 2, 3];
  const tC: Vec3 = [0.5, 0, -0.25];
  const local = mapPositions(world, (p) => [-(p[0] - tP[0]) / 2 - tC[0], -(p[1] - tP[1]) / 2 - tC[1], (p[2] - tP[2]) / 2 - tC[2]]);
  const doc: GltfDoc = {
    kind: 'gltf',
    container: 'glb',
    sceneName: 'hierarchy',
    sceneNodes: [0],
    nodes: [
      { name: 'assembly', translation: tP, rotation: [0, 0, 1, 0], scale: [2, 2, 2], children: [1] },
      { name: 'bracket', translation: tC, mesh: 0 },
    ],
    meshes: [{ name: 'bracket', primitives: [primitiveFromMesh(local, { vertexOrder: permutation(local.positions.length, 0x4e57) })] }],
    materials: [],
  };
  const base = prepare(obj(world, id, 'base'));
  const target = prepare(doc);
  const ref = referenceDiff(base.welded, target.welded);
  assertHand(
    `${id} baked positions are exact`,
    target.welded.positions.every((p, i) => p.every((c, k) => c === base.welded.positions[i][k])),
    true,
  );
  assertHand(`${id} all unchanged`, ref.stats.vertices.unchanged === base.welded.positions.length, true);
  const { vertexCount: v, faceCount: f } = size(base.welded);
  return {
    id,
    title: 'OBJ in world space vs GLB with a nested, rotated and scaled node hierarchy',
    description:
      `Base: the L-bracket solid (${v} vertices, ${f} triangles) in world coordinates as OBJ. Target: the same triangles in ` +
      'the same order in a GLB whose mesh sits under a child node (translation (0.5, 0, −0.25)) of a parent node ' +
      '(translation (1, 2, 3), rotation 180° about z, uniform scale 2); the stored local coordinates are the inverse image ' +
      'of the world coordinates and the vertex buffer is shuffled. Every factor is dyadic (the 180° quaternion gives an ' +
      'exact ±1/0 matrix), so baking parent·child world matrices reproduces the OBJ coordinates bit for bit. Expected: ' +
      'Tier 1, all Unchanged. A parser that skips parent transforms or composes them in the wrong order moves every vertex.',
    base,
    target,
    expect: exactExpect([1], base, target, ref),
  };
}

function multiPartObjGlb(): CaseDraft {
  const id = 'multi-part-obj-glb';
  const body = box([-1, -1, 0], [1, 1, 1], 'body:');
  const lidLocal = grid(2, 2, { spacing: 0.5, origin: [-0.5, -0.5, 0], prefix: 'lid:' });
  const lidWorld = mapPositions(lidLocal, (p) => [p[0], p[1], p[2] + 1.5]);
  const first = range(0, 5);
  const second = range(6, 11);
  const ob = new ObjBuilder()
    .comment(`polymerge fixture: ${id} (base)`)
    .object('body')
    .usemtl('red')
    .faces(body, first)
    .usemtl('blue')
    .faces(body, second)
    .object('lid')
    .group('lid_top')
    .usemtl('red')
    .faces(lidWorld);
  const doc: GltfDoc = {
    kind: 'gltf',
    container: 'glb',
    sceneName: 'parts',
    sceneNodes: [0, 1],
    nodes: [
      { name: 'body', mesh: 0 },
      { name: 'lid', mesh: 1, translation: [0, 0, 1.5] },
    ],
    meshes: [
      {
        name: 'body',
        primitives: [primitiveFromMesh(body, { faceIndices: first, material: 0 }), primitiveFromMesh(body, { faceIndices: second, material: 1 })],
      },
      { name: 'lid', primitives: [primitiveFromMesh(lidLocal, { material: 0 })] },
    ],
    materials: [
      { name: 'red', color: [0.8, 0.1, 0.1, 1] },
      { name: 'blue', color: [0.1, 0.2, 0.8, 1] },
    ],
  };
  const base = prepare(ob.build());
  const target = prepare(doc);
  const ref = referenceDiff(base.welded, target.welded);
  assertHand(`${id} sizes`, [size(base.welded), size(target.welded)], [
    { vertexCount: 17, faceCount: 20 },
    { vertexCount: 17, faceCount: 20 },
  ]);
  assertHand(`${id} identity`, ref.pairs.every(([b, t]) => b === t) && ref.stats.faces.unchanged === 20, true);
  return {
    id,
    title: 'Multi-object OBJ (o/g/usemtl) vs multi-node, multi-primitive GLB',
    description:
      'A box body (8 vertices, 12 triangles) plus a separate 2×2-quad lid plate (9 vertices, 8 triangles) floating at ' +
      'z = 1.5. Base OBJ: "o body" with two usemtl sections (red: triangles 0–5, blue: 6–11), then "o lid" / "g lid_top" ' +
      '(usemtl red). Target GLB: node "body" whose mesh has two primitives (red, blue — each with its own vertex buffer, ' +
      'so shared corners must be welded across primitives) and node "lid" translated by (0, 0, 1.5). Traversal order ' +
      '(body prim 0, body prim 1, lid) equals the OBJ face order, so both normalise to 17 vertices / 20 faces with ' +
      'identical indices. Expected: Tier 1, all Unchanged.',
    base,
    target,
    expect: exactExpect([1], base, target, ref),
  };
}

// ---------------------------------------------------------------------------
// Tier 1-or-2 / Tier 2 cases
// ---------------------------------------------------------------------------

function addedGeometry(): CaseDraft {
  const id = 'added-geometry';
  const g = grid(8, 8);
  // Open box (4 walls + lid) standing on the 2×2-quad footprint (3,3)–(5,5); bottom corners ARE grid vertices.
  const b = new MeshBuilder();
  const foot = [gridKey(3, 3), gridKey(5, 3), gridKey(5, 5), gridKey(3, 5)].map((k) => b.vertex(k, g.positions[g.keys.indexOf(k)]));
  const top = [
    [3, 3],
    [5, 3],
    [5, 5],
    [3, 5],
  ].map(([x, y], n) => b.vertex(`box:${n}`, [x, y, 1.5]));
  for (let n = 0; n < 4; n++) {
    const m = (n + 1) % 4;
    b.face(foot[n], foot[m], top[m]);
    b.face(foot[n], top[m], top[n]);
  }
  b.face(top[0], top[1], top[2]);
  b.face(top[0], top[2], top[3]);
  const withBox = appendMesh(g, b.build());
  const base = prepare(stl(g, 'binary', id, 'base'));
  const target = prepare(stl(withBox, 'binary', id, 'target'));
  const ref = referenceDiff(base.welded, target.welded);
  assertHand(`${id} sizes`, [size(base.welded), size(target.welded)], [
    { vertexCount: 81, faceCount: 128 },
    { vertexCount: 85, faceCount: 138 },
  ]);
  assertHand(`${id} vertices`, ref.stats.vertices, { unchanged: 81, moved: 0, added: 4, removed: 0 });
  assertHand(`${id} faces`, ref.stats.faces, { unchanged: 128, modified: 0, added: 10, removed: 0 });
  assertHand(`${id} identity prefix`, ref.pairs.every(([bb, t]) => bb === t), true);
  return {
    id,
    title: 'Grid plus an attached open box appended at the end (binary STL ↔ binary STL)',
    description:
      'Base: flat 8×8-quad grid (81 vertices, 128 triangles) as binary STL. Target: the same 128 triangles in the same ' +
      'order, followed by an open box (4 walls × 2 triangles + a 2-triangle lid = 10 triangles) standing on the 2×2-quad ' +
      'footprint (3,3)–(5,5): its 4 bottom corners are existing grid vertices (they weld onto them), its 4 top corners ' +
      'at z = 1.5 are new. Because the new faces come last, the grid vertices keep their welded indices 0..80 and the 4 ' +
      'new vertices get 81..84, so both an index-based Tier 1 and a geometric Tier 2 recover the same correspondence: ' +
      '81 Unchanged + 4 Added vertices, 128 Unchanged + 10 Added faces, nothing removed or moved.',
    base,
    target,
    expect: exactExpect([1, 2], base, target, ref),
  };
}

function removedPatch(): CaseDraft {
  const id = 'removed-patch';
  const g = grid(10, 10);
  const hole = quadFaces(10, block([4, 5, 6], [4, 5, 6]));
  const holed = removeFaces(g, (_, fi) => hole.has(fi));
  const base = prepare(obj(g, id, 'base'));
  const target = prepare(stl(holed, 'ascii', id, 'target', 'grid_with_hole'));
  const ref = referenceDiff(base.welded, target.welded);
  const shifted = ref.pairs.filter(([b, t]) => b !== t).length;
  const agreement = identityIndexFaceAgreement(base.welded, target.welded);
  assertHand(`${id} sizes`, [size(base.welded), size(target.welded)], [
    { vertexCount: 121, faceCount: 200 },
    { vertexCount: 117, faceCount: 182 },
  ]);
  assertHand(`${id} vertices`, ref.stats.vertices, { unchanged: 117, moved: 0, added: 0, removed: 4 });
  assertHand(`${id} faces`, ref.stats.faces, { unchanged: 182, modified: 0, added: 0, removed: 18 });
  return {
    id,
    title: 'Grid with an interior 3×3-quad hole (OBJ ↔ ASCII STL)',
    description:
      'Base: flat 10×10-quad grid (121 vertices, 200 triangles) as OBJ. Target: the same triangle stream as ASCII STL with ' +
      'the 18 triangles of the interior quads i,j ∈ {4,5,6} deleted (the rest keep their relative order). Exactly the 4 ' +
      'vertices strictly inside the hole — (5,5), (6,5), (5,6), (6,6) — are no longer referenced by any triangle and ' +
      'disappear on normalisation; the 12 hole-boundary vertices survive (they are corners of neighbouring quads). ' +
      `Expected: 117 Unchanged + 4 Removed vertices; 182 Unchanged + 18 Removed faces. Note: deleting faces mid-stream ` +
      `shifts first-appearance indices — ${shifted} of the 117 surviving vertices change index and only ${pct(agreement)} of ` +
      'target faces are base faces under the identity index map — so a plain index Tier 1 cannot produce this answer and ' +
      'the engine should resolve in Tier 2 (Tier 1 stays acceptable for an ID/sequence-aware Tier 1 giving the same ' +
      'correspondence). mustMatch lists all 117 surviving pairs through both welding orders.',
    base,
    target,
    expect: exactExpect([1, 2], base, target, ref),
  };
}

function shuffledFaces(): CaseDraft {
  const id = 'shuffled-faces';
  const g = grid(8, 8, { height: (i, j) => 0.125 * ((i + 2 * j) % 4), prefix: 's:' });
  const movedKey = gridKey(3, 5, 's:');
  const edited = moveVertices(g, [movedKey], [0, 0, 0.25]);
  const shuffled = rotateCorners(reorderFaces(edited, permutation(edited.faces.length, 0x5f1)), randomInts(edited.faces.length, 3, 0x5f2));
  const base = prepare(obj(g, id, 'base'));
  const target = prepare(obj(shuffled, id, 'target', permutation(shuffled.positions.length, 0x5f3)));
  const ref = referenceDiff(base.welded, target.welded);
  const agreement = identityIndexFaceAgreement(base.welded, target.welded);
  const kept = ref.pairs.filter(([b, t]) => b === t).length;
  assertHand(`${id} sizes`, size(target.welded), { vertexCount: 81, faceCount: 128 });
  assertHand(`${id} vertices`, ref.stats.vertices, { unchanged: 80, moved: 1, added: 0, removed: 0 });
  assertHand(`${id} faces`, ref.stats.faces, { unchanged: 122, modified: 6, added: 0, removed: 0 });
  if (agreement > 0.2) throw new Error(`${id}: shuffle too weak (${agreement})`);
  return {
    id,
    title: 'Same grid with shuffled triangle order and one moved vertex (OBJ ↔ OBJ)',
    description:
      'An 8×8-quad height-field grid (81 vertices, 128 triangles, z = 0.125·((i+2j) mod 4)) as OBJ. Target: same ' +
      'triangles in a deterministic shuffled order, each triangle\'s corners cyclically rotated (winding kept), the v ' +
      'lines shuffled too, and interior vertex (3,5) moved +0.25 z. The welded first-appearance order is scrambled: only ' +
      `${kept} of 81 vertices keep their index and ${pct(agreement)} of target faces are base faces under the identity ` +
      'index map, so Tier 1 must reject. Geometric + adjacency matching is unambiguous: 80 vertices have an exact ' +
      'positional twin, and the moved vertex (displacement 0.25) is the mutual nearest neighbour of its twin (grid ' +
      'spacing 1). Expected Tier 2: 1 Moved, 80 Unchanged; the 6 triangles around (3,5) Modified, 122 Unchanged. ' +
      'mustMatch lists all 81 pairs through both welding orders.',
    base,
    target,
    expect: exactExpect([2], base, target, ref),
  };
}

function mixedTopologyEdit(): CaseDraft {
  const id = 'mixed-topology-edit';
  const g = grid(12, 12, { prefix: 'm:' });
  const movedKeys = block([2, 3], [2, 3]).map(([i, j]) => gridKey(i, j, 'm:'));
  let t = moveVertices(g, movedKeys, [0, 0, 0.25]);
  const hole = quadFaces(12, block([7, 8, 9], [7, 8, 9]));
  t = removeFaces(t, (_, fi) => hole.has(fi));
  const flap = new MeshBuilder();
  const bottom = range(4, 7).map((j) => flap.vertex(gridKey(12, j, 'm:'), [12, j, 0]));
  const topV = range(4, 7).map((j) => flap.vertex(`flap:${j}`, [12, j, 1]));
  for (let n = 0; n < 3; n++) {
    flap.face(bottom[n], bottom[n + 1], topV[n + 1]);
    flap.face(bottom[n], topV[n + 1], topV[n]);
  }
  t = appendMesh(t, flap.build());
  t = rotateCorners(reorderFaces(t, permutation(t.faces.length, 0x3a1)), randomInts(t.faces.length, 3, 0x3a2));
  const base = prepare(obj(g, id, 'base'));
  const target = prepare(obj(t, id, 'target', permutation(t.positions.length, 0x3a3)));
  const ref = referenceDiff(base.welded, target.welded);
  const agreement = identityIndexFaceAgreement(base.welded, target.welded);
  // Hand derivation of the 16 modified faces around the 2×2 block (2..3)×(2..3): quads i,j ∈ 1..3;
  // corner quads (1,1) [raised v11, diagonal: 2], (3,3) [raised v00: 2], (3,1) [raised v01: 1], (1,3) [raised v10: 1];
  // the 4 edge quads and the centre quad hold ≥ 2 raised corners (2 each: 10). 2+2+1+1+10 = 16.
  assertHand(`${id} sizes`, [size(base.welded), size(target.welded)], [
    { vertexCount: 169, faceCount: 288 },
    { vertexCount: 169, faceCount: 276 },
  ]);
  assertHand(`${id} vertices`, ref.stats.vertices, { unchanged: 161, moved: 4, added: 4, removed: 4 });
  assertHand(`${id} faces`, ref.stats.faces, { unchanged: 254, modified: 16, added: 6, removed: 18 });
  return {
    id,
    title: 'Reordered faces + moved region + removed patch + added flap (OBJ ↔ OBJ)',
    description:
      'Base: flat 12×12-quad grid (169 vertices, 288 triangles) as OBJ. Target, all at once: (1) the 2×2 vertex block ' +
      'i,j ∈ {2,3} raised +0.25 z; (2) the 18 triangles of quads i,j ∈ {7,8,9} deleted, orphaning the 4 interior ' +
      'vertices (8,8),(9,8),(8,9),(9,9); (3) a vertical flap of 3 quads (6 triangles) attached to the x = 12 border ' +
      'edge between y = 4 and 7, adding 4 vertices at z = 1; (4) triangle order shuffled, corners rotated, v lines ' +
      `shuffled (identity-index face agreement ${pct(agreement)}, so Tier 1 must reject). Exact counts are guaranteed for ` +
      'Tier 2 by construction: every unchanged vertex has an exact positional twin; each moved vertex (displacement 0.25) ' +
      'is the mutual nearest neighbour of its twin (spacing 1) and has unchanged neighbours; the removed and added ' +
      'vertices are ≥ 1 unit from any unmatched vertex of the other side and not adjacent to each other, so no pairing ' +
      'between them is possible. Vertices: 161 Unchanged, 4 Moved, 4 Added, 4 Removed. Faces: 16 Modified (triangles ' +
      'touching the raised block), 18 Removed, 6 Added, 254 Unchanged on each side.',
    base,
    target,
    expect: exactExpect([2], base, target, ref),
  };
}

// ---------------------------------------------------------------------------
// Tier 3 cases
// ---------------------------------------------------------------------------

function rigidTransform(): CaseDraft {
  const id = 'rigid-transform';
  const solid = lBracket();
  const axis = normalize([1, 2, 2]);
  const angle = 30;
  const translation: Vec3 = [2.5, -1.25, 0.75];
  const q = quatFromAxisAngle(axis, angle);
  const shuffled = rotateCorners(reorderFaces(solid, permutation(solid.faces.length, 0x7a1)), randomInts(solid.faces.length, 3, 0x7a2));
  const base = prepare(obj(solid, id, 'base'));
  const target = prepare(
    singleMeshGltf(shuffled, 'glb', {
      name: 'bracket',
      translation,
      rotation: q,
      primitive: { vertexOrder: permutation(shuffled.positions.length, 0x7a3), indexType: 'u32' },
    }),
  );
  const matrix = composeTRS(translation, q);
  const ideal = referenceDiff(base.welded, target.welded, { checkTriples: false, baseToTarget: matrix });
  const n = base.welded.positions.length;
  const f = base.welded.faces.length;
  assertHand(`${id} ideal is all unchanged`, [ideal.stats.vertices.unchanged, ideal.stats.faces.unchanged], [n, f]);
  const maxResidual = Math.max(...ideal.displacement);
  if (maxResidual > ideal.moveEpsilon / 4) throw new Error(`${id}: float32 residual ${maxResidual} too close to moveEpsilon`);
  const ev = covarianceEigenvalues(base.welded.positions);
  const gap = Math.min((ev[0] - ev[1]) / ev[0], (ev[1] - ev[2]) / ev[0]);
  if (gap < 0.1) throw new Error(`${id}: PCA axes not well separated (${ev})`);
  const exact = exactPositionMatches(base.welded, target.welded);
  const minUnchanged = Math.ceil(0.9 * n);
  const slack = n - minUnchanged;
  const faceSlack = topValenceSum(base.welded, slack);
  const diag = Math.max(boundsDiagonal(base.welded.positions), boundsDiagonal(target.welded.positions));
  return {
    id,
    title: 'Asymmetric solid rotated 30° about (1,2,2) and translated, order shuffled (OBJ ↔ GLB)',
    description:
      `Base: the L-bracket solid (${n} vertices, ${f} triangles; covariance eigenvalues ${ev.map((e) => round(e)).join(' > ')}, ` +
      'so PCA axes are unambiguous and the shape has no symmetry) as OBJ. Target: GLB whose node applies rotation 30° about ' +
      'axis (1,2,2)/3 then translation (2.5, −1.25, 0.75) — base→target p ↦ R·p + t — with the triangle order shuffled, ' +
      `corners rotated and the vertex buffer shuffled (u32 indices). No vertex keeps its position (${exact} exact position ` +
      'matches), so Tiers 1 and 2 must reject; ICP must recover the transform. With the true alignment every target ' +
      `vertex lies within ${maxResidual.toExponential(1)} (float32 rounding of the baked node transform) of its base twin, ` +
      `well below moveEpsilon = 1e-6·diag ≈ ${ideal.moveEpsilon.toExponential(2)}, so the ideal result is all ${n} ` +
      `vertices / ${f} faces Unchanged and nothing Added/Removed (surfaceTolerance ≈ ${round(0.01 * diag)}). Ranges allow ` +
      `ICP to leave ≤ 10% of vertices (${slack}) above moveEpsilon; the face ranges follow (those vertices touch at most ` +
      `${faceSlack} faces). Alignment tolerance ${0.01}: |Δt| ≤ 0.01 units, |Δangle| ≤ 0.01°, axis within 0.01°. mustMatch ` +
      'lists every true pair (nearest neighbours after alignment are unambiguous: vertex spacing ≥ 1).',
    base,
    target,
    expect: {
      acceptableTiers: [3],
      vertices: { unchanged: [minUnchanged, n], moved: [0, slack], added: 0, removed: 0 },
      faces: { unchanged: [f - faceSlack, f], modified: [0, faceSlack], added: 0, removed: 0 },
      baseMesh: size(base.welded),
      targetMesh: size(target.welded),
      alignment: { translation, rotationAxis: axis, rotationDeg: angle, tolerance: 0.01 },
      mustMatch: ideal.pairs,
    },
  };
}

function remeshCylinder(): CaseDraft {
  const id = 'remesh';
  const coarse = cylinder(24);
  const fine = cylinder(32);
  const base = prepare(stl(coarse, 'binary', id, 'base'));
  const target = prepare(obj(fine, id, 'target'));
  assertHand(`${id} sizes`, [size(base.welded), size(target.welded)], [
    { vertexCount: 50, faceCount: 96 },
    { vertexCount: 66, faceCount: 128 },
  ]);
  const diag = Math.max(boundsDiagonal(base.welded.positions), boundsDiagonal(target.welded.positions));
  const surfaceTolerance = 0.01 * diag;
  const dT = maxSurfaceDistance(target.welded.positions, base.welded, pointTriangleDistance);
  const dB = maxSurfaceDistance(base.welded.positions, target.welded, pointTriangleDistance);
  // Hand: every ring vertex sits on a cap rim; a rim point at angle φ is outside the other n-gon by
  // cos(φ − m) − cos(π/n), m = midpoint angle of the chord spanning φ (same distance to the side wall and to the
  // cap edge). 32-gon vertex 22.5° is exactly a 24-gon chord midpoint → dT = 24-gon sagitta 1 − cos(7.5°).
  const rimDistance = (nSelf: number, nOther: number): number => {
    const step = (2 * Math.PI) / nOther;
    let worst = 0;
    for (let k = 0; k < nSelf; k++) {
      const phi = (2 * Math.PI * k) / nSelf;
      const mid = (Math.floor(phi / step + 1e-12) + 0.5) * step;
      worst = Math.max(worst, Math.cos(phi - mid) - Math.cos(step / 2));
    }
    return worst;
  };
  if (Math.abs(dT - rimDistance(32, 24)) > 1e-6 || Math.abs(dB - rimDistance(24, 32)) > 1e-6) {
    throw new Error(`${id}: surface distances ${dT}/${dB} ≠ analytic ${rimDistance(32, 24)}/${rimDistance(24, 32)}`);
  }
  assertHand(`${id} dT is the 24-gon sagitta`, Math.abs(dT - (1 - Math.cos(Math.PI / 24))) < 1e-6, true);
  if (Math.max(dT, dB) > 0.5 * surfaceTolerance) throw new Error(`${id}: remesh deviation too close to surfaceTolerance`);
  const exact = exactPositionMatches(base.welded, target.welded);
  const isCentre = (w: WeldedMesh) => (i: number) => w.positions[i][0] === 0 && w.positions[i][1] === 0;
  const ringValB = topValenceSum(base.welded, 1, isCentre(base.welded));
  const ringValT = topValenceSum(target.welded, 1, isCentre(target.welded));
  return {
    id,
    title: 'Cylinder at 24 vs 32 segments (binary STL ↔ OBJ)',
    description:
      'The same capped cylinder (r = 1, z ∈ [−1, 1], caps as triangle fans) tessellated with 24 segments (50 vertices, ' +
      '96 triangles, binary STL) and 32 segments (66 vertices, 128 triangles, OBJ). Only the 2 cap centres and the ' +
      `ring vertices at multiples of 45° coincide (${exact} of 66 target vertices), so no one-to-one vertex matching ` +
      'covers the meshes and Tiers 1 and 2 must reject. Under the identity alignment (or any rotation about the ' +
      `axis — the shape is rotationally symmetric) every target vertex is within the 24-gon sagitta 1 − cos(7.5°) ≈ ` +
      `${round(dT)} of the base surface and every base vertex within ${round(dB)} (< the 32-gon sagitta) of the target ` +
      `surface — at most ${pct(Math.max(dT, dB) / surfaceTolerance)} of surfaceTolerance = 1% of the bounds diagonal ≈ ` +
      `${round(surfaceTolerance)} — so Tier 3 ` +
      'should classify every vertex Unchanged or Moved and report nothing Added/Removed. The ranges allow up to 2 ' +
      `misclassified vertices; only ring vertices can plausibly exceed the tolerance (cap centres stay exactly on the ` +
      `other surface), and a ring vertex touches ${ringValB} (base) / ${ringValT} (target) triangles, giving the face ` +
      'bounds. Unchanged/Moved splits depend on ICP details and are not asserted.',
    base,
    target,
    expect: {
      acceptableTiers: [3],
      vertices: { added: [0, 2], removed: [0, 2] },
      faces: { added: [0, 2 * ringValT], removed: [0, 2 * ringValB] },
      baseMesh: size(base.welded),
      targetMesh: size(target.welded),
    },
  };
}

function remeshBox(): CaseDraft {
  const id = 'remesh-box';
  const coarse = subdividedBox(4, 3, 2, 2);
  const fine = subdividedBox(4, 3, 2, 3);
  const base = prepare(obj(coarse, id, 'base'));
  const target = prepare(singleMeshGltf(fine, 'glb', { name: 'box_k3' }));
  assertGenus0(`${id} base`, base.welded);
  assertGenus0(`${id} target`, target.welded);
  // Hand: surface lattice points of a 4×3×2 box at spacing 1/k = (4k+1)(3k+1)(2k+1) − (4k−1)(3k−1)(2k−1);
  // faces = 2 triangles × k² × 52 unit squares.
  assertHand(`${id} sizes`, [size(base.welded), size(target.welded)], [
    { vertexCount: 9 * 7 * 5 - 7 * 5 * 3, faceCount: 2 * 4 * 52 },
    { vertexCount: 13 * 10 * 7 - 11 * 8 * 5, faceCount: 2 * 9 * 52 },
  ]);
  const diag = Math.max(boundsDiagonal(base.welded.positions), boundsDiagonal(target.welded.positions));
  const dT = maxSurfaceDistance(target.welded.positions, base.welded, pointTriangleDistance);
  const dB = maxSurfaceDistance(base.welded.positions, target.welded, pointTriangleDistance);
  if (Math.max(dT, dB) > 1e-6) throw new Error(`${id}: surfaces differ (${dT}, ${dB})`);
  const exact = exactPositionMatches(base.welded, target.welded);
  const maxValB = topValenceSum(base.welded, 1);
  const maxValT = topValenceSum(target.welded, 1);
  return {
    id,
    title: 'Box surface subdivided at 1/2 vs 1/3 spacing (OBJ ↔ GLB)',
    description:
      'A 4×3×2 box centred on the origin whose faces are uniformly subdivided at spacing 1/2 (base: 210 vertices, 416 ' +
      'triangles, OBJ) and 1/3 (target: 470 vertices, 936 triangles, GLB; in-plane coordinates are float32-rounded thirds, ' +
      'the out-of-plane coordinate of every face is exact). Both tessellate exactly the same surface: under the identity ' +
      `alignment every vertex of either mesh lies on the other surface (max distance ${Math.max(dT, dB).toExponential(1)}), ` +
      'and the vertex sets are symmetric about the box centre, so centroid, principal axes and the ICP fixed point agree ' +
      '(any 180° flip ambiguity maps the box onto itself). Only integer lattice points coincide ' +
      `(${exact} of 470), so Tiers 1 and 2 must reject. Expected Tier 3 with nothing Added/Removed (ideal: all ` +
      `Unchanged; surfaceTolerance ≈ ${round(0.01 * diag)}); the ranges allow 2 misclassified vertices, i.e. at most ` +
      `2 × max valence (${maxValB} base / ${maxValT} target) faces.`,
    base,
    target,
    expect: {
      acceptableTiers: [3],
      vertices: { added: [0, 2], removed: [0, 2] },
      faces: { added: [0, 2 * maxValT], removed: [0, 2 * maxValB] },
      baseMesh: size(base.welded),
      targetMesh: size(target.welded),
    },
  };
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session 2 regression cases: moved parts and unit mismatch
// ---------------------------------------------------------------------------

/** Rotate `m` by quaternion q about the vertex centroid, then translate by d (float32-rounded). */
function moveRigidly(m: KMesh, q: Quat, d: Vec3): KMesh {
  const n = m.positions.length;
  const c = m.positions.reduce<Vec3>((acc, p) => [acc[0] + p[0] / n, acc[1] + p[1] / n, acc[2] + p[2] / n], [0, 0, 0]);
  const rot = composeTRS([0, 0, 0], q);
  return mapPositions(m, (p) => {
    const r = applyMat4(rot, [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
    return [r[0] + c[0] + d[0], r[1] + c[1] + d[1], r[2] + c[2] + d[2]];
  });
}

function movedPart(): CaseDraft {
  const id = 'moved-part';
  const body = lBracket('L:');
  const part = mapPositions(lBracket('P:'), (p) => [0.5 * p[0] + 6, 0.5 * p[1], 0.5 * p[2]]);
  const base0 = appendMesh(body, part);
  const angle = 30;
  const shift: Vec3 = [0, 2.5, 0.5];
  const movedP = moveRigidly(part, quatFromAxisAngle([0, 0, 1], angle), shift);
  let t = appendMesh(body, movedP);
  t = rotateCorners(reorderFaces(t, permutation(t.faces.length, 0x9a1)), randomInts(t.faces.length, 3, 0x9a2));
  const base = prepare(obj(base0, id, 'base'));
  const target = prepare(obj(t, id, 'target', permutation(t.positions.length, 0x9a3)));
  const ref = referenceDiff(base.welded, target.welded);
  const nBody = body.positions.length;
  const nPart = part.positions.length;
  assertHand(`${id} vertices`, ref.stats.vertices, { unchanged: nBody, moved: nPart, added: 0, removed: 0 });
  assertHand(`${id} faces`, ref.stats.faces, { unchanged: body.faces.length, modified: part.faces.length, added: 0, removed: 0 });
  assertHand(`${id} nothing coincides`, exactPositionMatches(base.welded, target.welded), nBody);
  return {
    id,
    title: 'A separate part rotated 30° and moved on its own, order shuffled (OBJ ↔ OBJ)',
    description:
      `Base: an L-bracket body (${nBody} vertices) plus a separate half-size L-bracket part (${nPart} vertices) at x ≈ 6, ` +
      `as one OBJ. Target: the part alone rotated ${angle}° about +z around its centroid and moved by (0, 2.5, 0.5); the ` +
      'body is untouched; triangle order, corners and v lines shuffled so only geometry can explain the correspondence. ' +
      'Regression for the session-1 bug where such a part read as Removed + Added: no vertex of the part keeps its ' +
      'position, so Tier 2 has no seeds there and must re-match the part by rigid registration. Expected: Tier 2, the ' +
      `body Unchanged, all ${nPart} part vertices Moved with their exact partners, one reported part motion.`,
    base,
    target,
    expect: { ...exactExpect([2], base, target, ref), parts: 1 },
  };
}

function unitsInchToMm(): CaseDraft {
  const id = 'units-inch-to-mm';
  const solid = lBracket('U:');
  const q = quatFromAxisAngle([0, 0, 1], 90);
  const translation: Vec3 = [10, 20, 0];
  const matrix = composeTRS(translation, q, [25.4, 25.4, 25.4]);
  let t = mapPositions(solid, (p) => applyMat4(matrix, p));
  t = rotateCorners(reorderFaces(t, permutation(t.faces.length, 0xb11)), randomInts(t.faces.length, 3, 0xb12));
  const base = prepare(stl(solid, 'binary', id, 'base'));
  const target = prepare(obj(t, id, 'target', permutation(t.positions.length, 0xb13)));
  const ideal = referenceDiff(base.welded, target.welded, { checkTriples: false, baseToTarget: matrix });
  const n = base.welded.positions.length;
  const f = base.welded.faces.length;
  assertHand(`${id} ideal is all unchanged`, [ideal.stats.vertices.unchanged, ideal.stats.faces.unchanged], [n, f]);
  const maxResidual = Math.max(...ideal.displacement);
  if (maxResidual > ideal.moveEpsilon / 4) throw new Error(`${id}: float32 residual ${maxResidual} too close to moveEpsilon`);
  assertHand(`${id} nothing coincides`, exactPositionMatches(base.welded, target.welded), 0);
  const slack = n - Math.ceil(0.9 * n);
  const faceSlack = topValenceSum(base.welded, slack);
  return {
    id,
    title: 'Same part exported in inches (STL) and millimetres (OBJ), rotated 90° and shuffled',
    description:
      `Base: the L-bracket (${n} vertices, ${f} triangles) in INCHES as binary STL. Target: the same part in MILLIMETRES ` +
      '(×25.4), turned 90° about +z and moved by (10, 20, 0) mm, as OBJ with shuffled order — what a second modelling ' +
      'tool with other unit settings produces. Regression for the session-1 bug where Tier 3 was rigid-only and read ' +
      'such a pair as almost everything Added. Expected: Tier 3 with a similarity alignment whose scale snaps to exactly ' +
      `25.4 (units in → mm); with it every vertex lies within ${maxResidual.toExponential(1)} (float32 rounding) of its ` +
      `twin, far below moveEpsilon ≈ ${ideal.moveEpsilon.toExponential(2)}, so all vertices are Unchanged (ranges allow ` +
      '10% ICP slack) and nothing is Added/Removed.',
    base,
    target,
    expect: {
      acceptableTiers: [3],
      vertices: { unchanged: [n - slack, n], moved: [0, slack], added: 0, removed: 0 },
      faces: { unchanged: [f - faceSlack, f], modified: [0, faceSlack], added: 0, removed: 0 },
      baseMesh: size(base.welded),
      targetMesh: size(target.welded),
      alignment: {
        translation,
        rotationAxis: [0, 0, 1],
        rotationDeg: 90,
        tolerance: 0.01,
        scale: 25.4,
        units: { from: 'in', to: 'mm', factor: 25.4 },
      },
      mustMatch: ideal.pairs,
      parts: 0,
    },
  };
}

function unitsSameLineage(): CaseDraft {
  const id = 'units-same-lineage';
  const solid = lBracket('S:');
  const matrix = composeTRS([0, 0, 0], [0, 0, 0, 1], [25.4, 25.4, 25.4]);
  const mm = mapPositions(solid, (p) => applyMat4(matrix, p));
  const base = prepare(stl(solid, 'binary', id, 'base'));
  const target = prepare(stl(mm, 'binary', id, 'target'));
  const ref = referenceDiff(base.welded, target.welded, { checkTriples: true, baseToTarget: matrix });
  const n = base.welded.positions.length;
  assertHand(`${id} vertices`, ref.stats.vertices, { unchanged: n, moved: 0, added: 0, removed: 0 });
  return {
    id,
    title: 'Same file re-exported in millimetres instead of inches, same order (STL ↔ STL)',
    description:
      `The L-bracket (${n} vertices) as binary STL in inches, and the identical triangle stream scaled ×25.4 (mm). ` +
      'Index lineage is intact, so Tier 1 matches every vertex — and before session 2 reported all of them as Moved. ' +
      'Expected now: Tier 1 plus ONE global transform (scale exactly 25.4, units in → mm, no rotation or translation), ' +
      'with every vertex and face Unchanged relative to it.',
    base,
    target,
    expect: {
      ...exactExpect([1], base, target, ref),
      alignment: {
        translation: [0, 0, 0],
        rotationAxis: [0, 0, 1],
        rotationDeg: 0,
        tolerance: 0.01,
        scale: 25.4,
        units: { from: 'in', to: 'mm', factor: 25.4 },
      },
      parts: 0,
    },
  };
}

const CASE_BUILDERS: Array<() => CaseDraft> = [
  identicalCube,
  cubeMovedCorner,
  gridBump,
  crossFormatStlObj,
  crossFormatObjGlb,
  gltfEmbeddedVsGlb,
  glbVertexIds,
  gltfMultiNode,
  degenerateTriangles,
  gltfNodeHierarchy,
  multiPartObjGlb,
  addedGeometry,
  removedPatch,
  shuffledFaces,
  mixedTopologyEdit,
  rigidTransform,
  remeshCylinder,
  remeshBox,
  movedPart,
  unitsInchToMm,
  unitsSameLineage,
];

export const MAX_FILE_BYTES = 200 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export function buildFixtures(): BuiltFixtures {
  const files = new Map<string, Uint8Array>();
  const cases: BuiltCase[] = [];
  const ids = new Set<string>();
  for (const build of CASE_BUILDERS) {
    const d = build();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.id)) throw new Error(`case id ${d.id} is not kebab-case`);
    if (ids.has(d.id)) throw new Error(`duplicate case id ${d.id}`);
    ids.add(d.id);
    const basePath = `cases/${d.id}/base.${fileExtension(d.base.doc)}`;
    const targetPath = `cases/${d.id}/target.${fileExtension(d.target.doc)}`;
    const baseBytes = writeFile(d.base.doc);
    const targetBytes = writeFile(d.target.doc);
    files.set(basePath, baseBytes);
    files.set(targetPath, targetBytes);
    cases.push({
      fixture: { id: d.id, title: d.title, description: d.description, base: basePath, target: targetPath, expect: d.expect },
      base: { ...d.base, bytes: baseBytes },
      target: { ...d.target, bytes: targetBytes },
    });
  }
  let total = 0;
  for (const [path, bytes] of files) {
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${path} is ${bytes.length} bytes (limit ${MAX_FILE_BYTES})`);
    total += bytes.length;
  }
  const manifest: IFixtureManifest = { version: 1, cases: cases.map((c) => c.fixture) };
  const manifestBytes = new TextEncoder().encode(formatJson(manifest) + '\n');
  total += manifestBytes.length;
  if (total > MAX_TOTAL_BYTES) throw new Error(`fixtures total ${total} bytes (limit ${MAX_TOTAL_BYTES})`);
  files.set('manifest.json', manifestBytes);
  return { manifest, cases, files };
}

/**
 * Deterministic, reviewable JSON: objects one key per line, arrays of scalars /
 * small tuples packed onto lines of ≤ 100 characters.
 */
export function formatJson(value: unknown, indent = ''): string {
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const compact = value.every((v) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')));
    if (compact) {
      const items = value.map((v) => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v)));
      const oneLine = `[${items.join(', ')}]`;
      if (oneLine.length + indent.length <= 100) return oneLine;
      const lines: string[] = [];
      let line = '';
      for (const it of items) {
        if (line && inner.length + line.length + it.length + 2 > 100) {
          lines.push(line);
          line = '';
        }
        line += (line ? ', ' : '') + it;
      }
      if (line) lines.push(line);
      return `[\n${lines.map((l, i) => inner + l + (i < lines.length - 1 ? ',' : '')).join('\n')}\n${indent}]`;
    }
    return `[\n${value.map((v) => inner + formatJson(v, inner)).join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    const scalarish = entries.every(([, v]) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')));
    if (scalarish) {
      const oneLine = `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${formatJson(v, inner)}`).join(', ')} }`;
      if (!oneLine.includes('\n') && oneLine.length + indent.length <= 100) return oneLine;
    }
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJson(v, inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}
