/**
 * Self-check of the fixture GENERATOR, independent of polymerge's parsers and diff
 * engine. Every file is re-read with the stock three.js loaders (STLLoader,
 * OBJLoader, GLTFLoader) — the same loaders the parsers are required to use — then
 * welded with the reference welder and compared with the manifest; the manifest's
 * expected counts are re-derived from the loaded data + mustMatch by the contract's
 * status rules. It also checks size limits and that the generator is byte-stable.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mesh, Vector3, type BufferGeometry, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CountExpectation, IFixtureCase, IFixtureManifest } from '../packages/core/src/types.js';
import { VertexStatus } from '../packages/core/src/types.js';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, buildFixtures } from './lib/cases.js';
import { applyMat4, boundsDiagonal, composeTRS, distance, f32, pointTriangleDistance, quatFromAxisAngle } from './lib/math.js';
import {
  countCodes,
  faceStatusesByContract,
  flatFaces,
  identityIndexFaceAgreement,
  maxSurfaceDistance,
  positionKey,
  weld,
  type WeldCorner,
  type WeldedMesh,
} from './lib/reference.js';
import { packGlb } from './lib/writers.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8')) as IFixtureManifest;

interface Loaded {
  /** Triangles as delivered by the loader (world space, float32 corners). */
  triangles: number;
  welded: WeldedMesh;
  /** Welded vertex → `_VERTEX_ID` (glTF only; null when absent). */
  ids: (string | null)[];
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Collect world-space triangle corners from a three.js scene in traversal order. */
function collectScene(root: Object3D): WeldCorner[][] {
  root.updateMatrixWorld(true);
  const tris: WeldCorner[][] = [];
  const v = new Vector3();
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const geom = o.geometry as BufferGeometry;
    const pos = geom.getAttribute('position');
    const idAttr = geom.getAttribute('_vertex_id');
    const index = geom.getIndex();
    const count = index ? index.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const tri: WeldCorner[] = [];
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(i + k) : i + k;
        v.fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld);
        tri.push({ p: [f32(v.x), f32(v.y), f32(v.z)], key: idAttr ? String(idAttr.getX(vi)) : null });
      }
      tris.push(tri);
    }
  });
  return tris;
}

function decodeDataUri(uri: string): Uint8Array {
  const m = /^data:[^;,]*;base64,(.*)$/.exec(uri);
  if (!m) throw new Error(`unsupported buffer uri ${uri.slice(0, 40)}`);
  return new Uint8Array(Buffer.from(m[1], 'base64'));
}

/** Triangle count straight from glTF JSON (scene DFS × primitive index counts). */
function gltfJsonTriangleCount(json: any): number {
  let total = 0;
  const visit = (n: number) => {
    const node = json.nodes[n];
    if (node.mesh !== undefined) {
      for (const p of json.meshes[node.mesh].primitives) {
        expect(p.mode ?? 4).toBe(4);
        total += (p.indices !== undefined ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count) / 3;
      }
    }
    for (const c of node.children ?? []) visit(c);
  };
  for (const n of json.scenes[json.scene ?? 0].nodes) visit(n);
  return total;
}

async function loadWithThree(path: string): Promise<Loaded> {
  const bytes = new Uint8Array(readFileSync(join(here, path)));
  const ext = path.split('.').pop();
  let tris: WeldCorner[][];
  if (ext === 'stl') {
    const geom = new STLLoader().parse(arrayBufferOf(bytes));
    const pos = geom.getAttribute('position');
    tris = [];
    for (let i = 0; i < pos.count; i += 3) {
      tris.push([0, 1, 2].map((k) => ({ p: [pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)], key: null })));
    }
  } else if (ext === 'obj') {
    tris = collectScene(new OBJLoader().parse(new TextDecoder().decode(bytes)));
  } else if (ext === 'glb') {
    const gltf = await new GLTFLoader().parseAsync(arrayBufferOf(bytes), '');
    tris = collectScene(gltf.scene);
  } else if (ext === 'gltf') {
    // GLTFLoader cannot fetch data: URIs under Node (ProgressEvent is not defined), so decode the JSON
    // ourselves, count triangles from the accessors, and hand the same JSON + decoded buffer to
    // GLTFLoader as an in-memory GLB.
    const json = JSON.parse(new TextDecoder().decode(bytes));
    expect(json.buffers).toHaveLength(1);
    const bin = decodeDataUri(json.buffers[0].uri);
    expect(bin.length).toBe(json.buffers[0].byteLength);
    const jsonTriangles = gltfJsonTriangleCount(json);
    const { uri: _uri, ...buffer0 } = json.buffers[0];
    const gltf = await new GLTFLoader().parseAsync(arrayBufferOf(packGlb({ ...json, buffers: [buffer0] }, bin)), '');
    tris = collectScene(gltf.scene);
    expect(tris.length).toBe(jsonTriangles);
  } else {
    throw new Error(`unknown extension ${ext}`);
  }
  const welded = weld(tris);
  return { triangles: tris.length, welded, ids: welded.keys };
}

function inRange(actual: number, exp: CountExpectation): boolean {
  return typeof exp === 'number' ? actual === exp : actual >= exp[0] && actual <= exp[1];
}

function allFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

describe('fixture generator: manifest and files', () => {
  it('manifest is version 1 with unique kebab-case ids and fixture-relative paths', () => {
    expect(manifest.version).toBe(1);
    const ids = manifest.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(manifest.cases.length).toBeGreaterThanOrEqual(14);
    for (const c of manifest.cases) {
      expect(c.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(c.base).toMatch(new RegExp(`^cases/${c.id}/base\\.(stl|obj|gltf|glb)$`));
      expect(c.target).toMatch(new RegExp(`^cases/${c.id}/target\\.(stl|obj|gltf|glb)$`));
      expect(existsSync(join(here, c.base))).toBe(true);
      expect(existsSync(join(here, c.target))).toBe(true);
      expect(c.expect.acceptableTiers.length).toBeGreaterThan(0);
      expect(c.expect.baseMesh).toBeDefined();
      expect(c.expect.targetMesh).toBeDefined();
      expect(c.description.length).toBeGreaterThan(80);
    }
  });

  it('covers every required scenario', () => {
    const ids = new Set(manifest.cases.map((c) => c.id));
    for (const id of [
      'identical-cube',
      'cube-moved-corner',
      'grid-bump',
      'cross-format-identical',
      'cross-format-identical-obj-glb',
      'gltf-embedded-vs-glb',
      'glb-vertex-ids',
      'gltf-multi-node',
      'shuffled-faces',
      'added-geometry',
      'removed-patch',
      'mixed-topology-edit',
      'rigid-transform',
      'remesh',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('keeps every file < 200 KB and the total < 2 MB', () => {
    const files = allFiles(join(here, 'cases')).concat(join(here, 'manifest.json'));
    let total = 0;
    for (const f of files) {
      const s = statSync(f).size;
      expect(s, f).toBeLessThan(MAX_FILE_BYTES);
      total += s;
    }
    expect(total).toBeLessThan(MAX_TOTAL_BYTES);
  });

  it('is deterministic in-process and matches the files on disk byte for byte', () => {
    const a = buildFixtures();
    const b = buildFixtures();
    expect([...a.files.keys()]).toEqual([...b.files.keys()]);
    for (const [path, bytes] of a.files) {
      expect(Buffer.compare(Buffer.from(bytes), Buffer.from(b.files.get(path)!)), path).toBe(0);
      expect(Buffer.compare(Buffer.from(bytes), readFileSync(join(here, path))), `${path} is stale — run npm run fixtures`).toBe(0);
    }
    const onDisk = allFiles(join(here, 'cases')).map((p) => relative(here, p).split('\\').join('/'));
    expect(onDisk.sort()).toEqual([...a.files.keys()].filter((p) => p.startsWith('cases/')).sort());
  });

  it('re-running the generator CLI reproduces every file byte for byte', () => {
    const out = mkdtempSync(join(tmpdir(), 'polymerge-fixtures-'));
    try {
      execFileSync(join(repoRoot, 'node_modules', '.bin', 'tsx'), [join(here, 'generate.ts'), '--out', out, '--quiet'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
      const regenerated = allFiles(out).map((p) => relative(out, p).split('\\').join('/'));
      const committed = allFiles(join(here, 'cases'))
        .map((p) => relative(here, p).split('\\').join('/'))
        .concat('manifest.json')
        .sort();
      expect(regenerated).toEqual(committed);
      for (const rel of regenerated) {
        expect(Buffer.compare(readFileSync(join(out, rel)), readFileSync(join(here, rel))), rel).toBe(0);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

const built = buildFixtures();
const builtById = new Map(built.cases.map((c) => [c.fixture.id, c]));

describe.each(manifest.cases)('fixture $id (three.js loaders, no polymerge code)', (fc: IFixtureCase) => {
  let loadedPair: { base: Loaded; target: Loaded } | undefined;
  beforeAll(async () => {
    loadedPair = { base: await loadWithThree(fc.base), target: await loadWithThree(fc.target) };
  });
  const loaded = async (): Promise<{ base: Loaded; target: Loaded }> => {
    if (!loadedPair) throw new Error('files failed to load');
    return loadedPair;
  };

  it('three.js loaders deliver the generated triangle counts and weld to the manifest sizes', async () => {
    const { base, target } = await loaded();
    const b = builtById.get(fc.id)!;
    expect(base.triangles).toBe(b.base.sourceTriangles);
    expect(target.triangles).toBe(b.target.sourceTriangles);
    expect({ vertexCount: base.welded.positions.length, faceCount: base.welded.faces.length }).toEqual(fc.expect.baseMesh);
    expect({ vertexCount: target.welded.positions.length, faceCount: target.welded.faces.length }).toEqual(fc.expect.targetMesh);
    // the loaders' welded positions are exactly the generator's
    expect(base.welded.positions.map(positionKey)).toEqual(b.base.welded.positions.map(positionKey));
    expect(target.welded.positions.map(positionKey)).toEqual(b.target.welded.positions.map(positionKey));
    expect(base.welded.faces).toEqual(b.base.welded.faces);
    expect(target.welded.faces).toEqual(b.target.welded.faces);
  });

  it('mustMatch is a partial bijection within the vertex ranges', async () => {
    const { base, target } = await loaded();
    const pairs = fc.expect.mustMatch ?? [];
    const bs = new Set(pairs.map((p) => p[0]));
    const ts = new Set(pairs.map((p) => p[1]));
    expect(bs.size).toBe(pairs.length);
    expect(ts.size).toBe(pairs.length);
    for (const [b, t] of pairs) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(base.welded.positions.length);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(target.welded.positions.length);
    }
  });

  const tiers = fc.expect.acceptableTiers;
  const exactTopological = tiers.every((t) => t !== 3);

  it.runIf(exactTopological)('expected counts follow from mustMatch by the contract status rules', async () => {
    const { base, target } = await loaded();
    const e = fc.expect;
    const pairs = e.mustMatch!;
    // mustMatch is the COMPLETE correspondence for these cases
    expect(pairs.length).toBe((e.vertices!.unchanged as number) + (e.vertices!.moved as number));
    const nb = base.welded.positions.length;
    const nt = target.welded.positions.length;
    const b2t = new Int32Array(nb).fill(-1);
    const t2b = new Int32Array(nt).fill(-1);
    for (const [b, t] of pairs) {
      b2t[b] = t;
      t2b[t] = b;
    }
    const eps = 1e-6 * Math.max(boundsDiagonal(base.welded.positions), boundsDiagonal(target.welded.positions));
    // A Tier 1/2 case may expect a global transform (e.g. a unit re-export): statuses are relative to it.
    const a = e.alignment;
    const g = a ? composeTRS(a.translation, quatFromAxisAngle(a.rotationAxis, a.rotationDeg), [a.scale ?? 1, a.scale ?? 1, a.scale ?? 1]) : null;
    const tvs = new Uint8Array(nt);
    const bvs = new Uint8Array(nb);
    for (let t = 0; t < nt; t++) {
      if (t2b[t] < 0) tvs[t] = VertexStatus.Added;
      else {
        const from = g ? applyMat4(g, base.welded.positions[t2b[t]]) : base.welded.positions[t2b[t]];
        const d = distance(from, target.welded.positions[t]);
        // exact fixtures: every displacement is 0 (up to float32 rounding of a transform) or far above moveEpsilon
        expect(d <= (g ? eps / 4 : 0) || d > 1000 * eps).toBe(true);
        tvs[t] = d <= eps ? VertexStatus.Unchanged : VertexStatus.Moved;
      }
    }
    for (let b = 0; b < nb; b++) bvs[b] = b2t[b] < 0 ? VertexStatus.Removed : tvs[b2t[b]];
    const fs = faceStatusesByContract(flatFaces(base.welded.faces), flatFaces(target.welded.faces), b2t, t2b, bvs, tvs, true);
    const tv = countCodes(tvs);
    const bv = countCodes(bvs);
    const tf = countCodes(fs.target);
    const bf = countCodes(fs.base);
    expect({ unchanged: tv[0], moved: tv[1], added: tv[2], removed: bv[3] }).toEqual(e.vertices);
    expect({ unchanged: tf[0], modified: tf[1], added: tf[2], removed: bf[3] }).toEqual(e.faces);
    // symmetric counts on both sides (one-to-one matching, no duplicate faces)
    expect([bv[0], bv[1]]).toEqual([tv[0], tv[1]]);
    expect([bf[0], bf[1]]).toEqual([tf[0], tf[1]]);
    // unmatched vertices are exactly those without a partner that could be matched geometrically:
    // no unmatched target vertex shares an exact position with an unmatched base vertex
    const unmatchedBase = new Set(base.welded.positions.filter((_, b) => b2t[b] < 0).map(positionKey));
    for (let t = 0; t < nt; t++) if (t2b[t] < 0) expect(unmatchedBase.has(positionKey(target.welded.positions[t]))).toBe(false);
  });

  it.runIf(exactTopological && tiers.includes(1) && tiers.length === 1)('Tier 1 is viable: index identity or _VERTEX_ID', async () => {
    const { base, target } = await loaded();
    const pairs = fc.expect.mustMatch!;
    const hasIds = base.ids.some((k) => k !== null);
    if (hasIds) {
      // ids are unique per file and carried with the vertices: every expected pair shares its id
      expect(new Set(base.ids).size).toBe(base.ids.length);
      expect(new Set(target.ids).size).toBe(target.ids.length);
      for (const [b, t] of pairs) expect(target.ids[t], `pair ${b}→${t}`).toBe(base.ids[b]);
      // …and the index orders really disagree, so only the ids can explain the correspondence
      expect(pairs.filter(([b, t]) => b === t).length).toBeLessThan(pairs.length / 2);
    } else {
      for (const [b, t] of pairs) expect(t).toBe(b);
      expect(identityIndexFaceAgreement(base.welded, target.welded)).toBe(1);
      expect(target.welded.faces).toEqual(base.welded.faces);
    }
  });

  it.runIf(tiers.every((t) => t >= 2))('Tier 1 is NOT viable by index (acceptable tiers exclude 1)', async () => {
    const { base, target } = await loaded();
    expect(identityIndexFaceAgreement(base.welded, target.welded)).toBeLessThan(0.5);
    expect(base.ids.every((k) => k === null) && target.ids.every((k) => k === null)).toBe(true);
  });

  it.runIf(fc.expect.alignment !== undefined)('every mustMatch pair satisfies target = R·base + t', async () => {
    const { base, target } = await loaded();
    const a = fc.expect.alignment!;
    const m = composeTRS(a.translation, quatFromAxisAngle(a.rotationAxis, a.rotationDeg), [a.scale ?? 1, a.scale ?? 1, a.scale ?? 1]);
    const eps = 1e-6 * Math.max(boundsDiagonal(base.welded.positions), boundsDiagonal(target.welded.positions));
    const pairs = fc.expect.mustMatch!;
    expect(pairs.length).toBe(base.welded.positions.length);
    let worst = 0;
    for (const [b, t] of pairs) worst = Math.max(worst, distance(applyMat4(m, base.welded.positions[b]), target.welded.positions[t]));
    // ideal alignment ⇒ every vertex Unchanged (d ≤ moveEpsilon), consistent with the expected ranges
    expect(worst).toBeLessThan(eps / 4);
    expect(inRange(base.welded.positions.length, fc.expect.vertices!.unchanged!)).toBe(true);
    expect(inRange(base.welded.faces.length, fc.expect.faces!.unchanged!)).toBe(true);
    // Tier 3 cases: no exact position survives the motion, so Tiers 1/2 have nothing to match
    if (tiers.every((t) => t === 3)) {
      const set = new Set(base.welded.positions.map(positionKey));
      expect(target.welded.positions.filter((p) => set.has(positionKey(p))).length).toBe(0);
    }
  });

  it.runIf(tiers.length === 1 && tiers[0] === 3 && fc.expect.alignment === undefined)(
    'remesh: both surfaces coincide within half the surface tolerance (so nothing is Added/Removed)',
    async () => {
      const { base, target } = await loaded();
      const tol = 0.01 * Math.max(boundsDiagonal(base.welded.positions), boundsDiagonal(target.welded.positions));
      const dT = maxSurfaceDistance(target.welded.positions, base.welded, pointTriangleDistance);
      const dB = maxSurfaceDistance(base.welded.positions, target.welded, pointTriangleDistance);
      expect(Math.max(dT, dB)).toBeLessThan(tol / 2);
      expect(inRange(0, fc.expect.vertices!.added!)).toBe(true);
      expect(inRange(0, fc.expect.vertices!.removed!)).toBe(true);
      // a one-to-one matching cannot cover both meshes: at most min(nb, nt) exact coincidences, far from all
      const set = new Set(base.welded.positions.map(positionKey));
      const exact = target.welded.positions.filter((p) => set.has(positionKey(p))).length;
      expect(exact).toBeLessThan(0.5 * Math.min(base.welded.positions.length, target.welded.positions.length));
    },
  );
});
