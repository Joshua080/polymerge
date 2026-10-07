/**
 * CAD faces of STEP models: surface fitting (src/brep.ts) and the face-aware diff
 * (src/diff/brep.ts). The models come from a FAKE importer that builds a plate with round holes
 * the way OpenCascade returns it (every B-rep face its own vertices, approximate normals), so the
 * whole path loader → fit → diff runs without the wasm. The CLI's STEP tests run the real
 * importer on real files.
 */
import { describe, expect, it } from 'vitest';
import { describeSurface, fitSurface, sameSurface, surfaceChange, transformSurface } from '../src/brep.js';
import { diffMeshes } from '../src/diff/index.js';
import { loadMesh } from '../src/parsers/index.js';
import { FaceStatus, type IBrepSurface, type IMesh, type IStepImporter, type IStepImportMesh, type Vec3 } from '../src/types.js';

const silent = { info: () => {}, warn: () => {} };

// ---------------------------------------------------------------------------------------------
// Surface fitting
// ---------------------------------------------------------------------------------------------

/** Points and (slightly wrong, like OpenCascade's) normals sampled from a surface. */
function sample(f: (u: number, v: number) => [Vec3, Vec3], nu: number, nv: number, normalNoise = 0.05): { pts: number[]; nrm: number[]; n: number } {
  const pts: number[] = [];
  const nrm: number[] = [];
  let k = 0;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const [p, n] = f(i / (nu - 1), j / (nv - 1));
      pts.push(...p);
      // Tilt each normal a little within the plane it should stay in: like averaged facet normals.
      const wobble = normalNoise * Math.sin(17 * k++);
      nrm.push(n[0] + wobble * n[1], n[1] - wobble * n[0], n[2]);
    }
  }
  return { pts, nrm, n: nu * nv };
}

const fit = (s: ReturnType<typeof sample>, tol = 1e-6) => fitSurface(s.pts, s.nrm, s.n, tol);

describe('fitSurface', () => {
  it('plane: normal and offset', () => {
    const s = sample((u, v) => [[u * 10, v * 5, 3], [0, 0, 1]], 4, 4, 0);
    expect(fit(s)).toEqual({ type: 'plane', normal: [0, 0, 1], offset: 3 });
    expect(describeSurface(fit(s))).toBe('flat face facing +Z');
  });

  it('full cylinder: a hole (normals toward the axis) and a boss (away from it)', () => {
    const cyl = (r: number, inward: boolean) =>
      sample((u, v) => {
        const a = 2 * Math.PI * u * 0.98;
        const n: Vec3 = inward ? [-Math.cos(a), -Math.sin(a), 0] : [Math.cos(a), Math.sin(a), 0];
        return [[30 + r * Math.cos(a), r * Math.sin(a), v * 10], n];
      }, 24, 3);
    const hole = fit(cyl(4, true)) as Extract<IBrepSurface, { type: 'cylinder' }>;
    expect(hole.type).toBe('cylinder');
    expect(hole.axis).toEqual([0, 0, 1]);
    expect(hole.radius).toBeCloseTo(4, 9);
    expect(hole.origin[0]).toBeCloseTo(30, 9);
    expect(hole.inward).toBe(true);
    expect(hole.full).toBe(true);
    expect(describeSurface(hole)).toBe('hole Ø8');
    const boss = fit(cyl(2.5, false));
    expect(describeSurface(boss)).toBe('cylinder Ø5');
  });

  it('partial cylinder (a fillet): a round with its radius', () => {
    const s = sample((u, v) => {
      const a = (Math.PI / 2) * u;
      return [[-45 + 5 * Math.cos(a + Math.PI / 2), 25 + 5 * Math.sin(a + Math.PI / 2), v * 10], [Math.cos(a + Math.PI / 2), Math.sin(a + Math.PI / 2), 0]];
    }, 9, 2);
    const sf = fit(s);
    expect(sf).toMatchObject({ type: 'cylinder', full: false, inward: false });
    expect(describeSurface(sf)).toBe('outer round r5');
  });

  it('cone and sphere', () => {
    const half = (30 * Math.PI) / 180;
    const cone = sample((u, v) => {
      const a = 2 * Math.PI * u * 0.97;
      const h = 1 + 4 * v;
      const r = h * Math.tan(half);
      return [[r * Math.cos(a), r * Math.sin(a), h], [Math.cos(half) * Math.cos(a), Math.cos(half) * Math.sin(a), -Math.sin(half)]];
    }, 20, 4, 0);
    const c = fit(cone, 1e-6) as Extract<IBrepSurface, { type: 'cone' }>;
    expect(c.type).toBe('cone');
    expect(c.halfAngleDeg).toBeCloseTo(30, 6);
    expect(c.apex.map((x) => Number(x.toFixed(6)))).toEqual([0, 0, 0]);
    expect(describeSurface(c)).toBe('cone 60°');
    const sphere = sample((u, v) => {
      const th = 0.3 + 1.2 * u;
      const ph = 2 * Math.PI * v * 0.9;
      const n: Vec3 = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
      return [[1 + 5 * n[0], 2 + 5 * n[1], 3 + 5 * n[2]], n];
    }, 8, 8);
    const sp = fit(sphere) as Extract<IBrepSurface, { type: 'sphere' }>;
    expect(sp.type).toBe('sphere');
    expect(sp.radius).toBeCloseTo(5, 9);
    expect(describeSurface(sp)).toBe('sphere Ø10');
  });

  it('anything else is "other"', () => {
    // A saddle: z = x·y.
    const s = sample((u, v) => {
      const x = u * 2 - 1;
      const y = v * 2 - 1;
      return [[x, y, x * y], [-y, -x, 1]];
    }, 6, 6, 0);
    expect(fit(s, 1e-4)).toEqual({ type: 'other' });
  });
});

describe('comparing surfaces', () => {
  const hole = (x: number, r: number): IBrepSurface => ({ type: 'cylinder', axis: [0, 0, 1], origin: [x, 0, 0], radius: r, inward: true, full: true });

  it('same surface, moved, resized', () => {
    expect(sameSurface(hole(30, 4), hole(30, 4 + 1e-9), 1e-6)).toBe(true);
    expect(sameSurface(hole(30, 4), hole(35, 4), 1e-6)).toBe(false);
    expect(surfaceChange(hole(30, 4), hole(35, 4), 1e-6)).toEqual({ offset: [5, 0, 0], size: null });
    expect(surfaceChange(hole(30, 4), hole(30, 4.05), 1e-6)?.size).toEqual([4, 4.05]);
    // A hole never pairs with a boss.
    expect(surfaceChange(hole(30, 4), { ...hole(30, 4), inward: false }, 1e-6)).toBeNull();
  });

  it('transformSurface applies a rigid motion and a scale', () => {
    // Rotate 90° about Z, move +1 in x, scale 2.
    const m = [0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 1, 0, 0, 1];
    const moved = transformSurface(hole(30, 4), m, 2) as Extract<IBrepSurface, { type: 'cylinder' }>;
    expect(moved.radius).toBe(8);
    expect(moved.origin.map((x) => Number(x.toFixed(9)))).toEqual([1, 60, 0]);
    const plane = transformSurface({ type: 'plane', normal: [0, 0, 1], offset: 3 }, m, 2);
    expect(plane).toEqual({ type: 'plane', normal: [0, 0, 1], offset: 6 });
  });
});

// ---------------------------------------------------------------------------------------------
// A plate with round holes, the way OpenCascade returns it
// ---------------------------------------------------------------------------------------------

interface PlateSpec {
  holes: [x: number, y: number, r: number][];
  /** x where the top / bottom faces are cut into strips for meshing (each hole inside one strip). */
  splits: number[];
  thickness?: number;
  segments?: number;
}

type V2 = [number, number];

/** Triangulate the region between a convex polygon and a circle inside it (both counter-clockwise). */
function ring(outer: V2[], centre: V2, r: number, segments: number): [V2, V2, V2][] {
  const ang = (p: V2) => {
    const a = Math.atan2(p[1] - centre[1], p[0] - centre[0]);
    return a < 0 ? a + 2 * Math.PI : a;
  };
  // Angles measured from the first outer corner, so both loops start together and wrap together.
  const a0 = ang(outer[0]);
  const rel = (p: V2) => (ang(p) - a0 + 2 * Math.PI) % (2 * Math.PI);
  const circle: V2[] = Array.from({ length: segments }, (_, k) => {
    const a = (2 * Math.PI * k) / segments;
    return [centre[0] + r * Math.cos(a), centre[1] + r * Math.sin(a)];
  });
  const first = circle.reduce((best, p, i) => (rel(p) < rel(circle[best]) ? i : best), 0);
  const inner = circle.map((_, i) => circle[(first + i) % segments]);
  const at = (list: V2[], i: number) => (i >= list.length ? 2 * Math.PI + rel(list[i - list.length]) : rel(list[i]));
  const tris: [V2, V2, V2][] = [];
  let i = 0;
  let j = 0;
  while (i < outer.length || j < inner.length) {
    if (j < inner.length && (i >= outer.length || at(inner, j + 1) <= at(outer, i + 1))) {
      tris.push([outer[i % outer.length], inner[j % inner.length], inner[(j + 1) % inner.length]]);
      j++;
    } else {
      tris.push([outer[i % outer.length], inner[j % inner.length], outer[(i + 1) % outer.length]]);
      i++;
    }
  }
  return tris;
}

function plateMesh(spec: PlateSpec): IStepImportMesh {
  const T = spec.thickness ?? 10;
  const seg = spec.segments ?? 24;
  const position: number[] = [];
  const normal: number[] = [];
  const index: number[] = [];
  const brep_faces: { first: number; last: number }[] = [];
  const face = (tris: [Vec3, Vec3, Vec3][], n: (p: Vec3) => Vec3) => {
    const first = index.length / 3;
    for (const tri of tris) {
      // Wind every triangle to agree with its outward normal.
      const [a, b, c] = tri;
      const cross = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
      const ctr: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      const nn = n(ctr);
      const ordered = cross[0] * nn[0] + cross[1] * nn[1] + cross[2] * nn[2] >= 0 ? [a, b, c] : [a, c, b];
      for (const p of ordered) {
        index.push(position.length / 3);
        position.push(...p);
        normal.push(...n(p));
      }
    }
    brep_faces.push({ first, last: index.length / 3 - 1 });
  };
  const xs = [-50, ...spec.splits, 50];
  const strips: [V2, V2, V2][] = [];
  for (let s = 0; s + 1 < xs.length; s++) {
    const rect: V2[] = [
      [xs[s], -30],
      [xs[s + 1], -30],
      [xs[s + 1], 30],
      [xs[s], 30],
    ];
    // Points every ≤ 2.5 mm along the outline: neighbouring strips share their border points (a
    // conforming mesh, as OpenCascade makes), and the outline interleaves with a hole's circle.
    const outline: V2[] = [];
    rect.forEach((a, k) => {
      const b = rect[(k + 1) % 4];
      const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2.5);
      for (let i = 0; i < n; i++) outline.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
    });
    const inside = spec.holes.filter(([x]) => x > xs[s] && x < xs[s + 1]);
    if (inside.length === 0) {
      const c: V2 = [(xs[s] + xs[s + 1]) / 2, 0];
      outline.forEach((p, k) => strips.push([c, p, outline[(k + 1) % outline.length]]));
    } else {
      const [hx, hy, hr] = inside[0];
      strips.push(...ring(outline, [hx, hy], hr, seg));
    }
  }
  const lift = (z: number) => strips.map((t) => t.map(([x, y]) => [x, y, z] as Vec3) as [Vec3, Vec3, Vec3]);
  face(lift(T), () => [0, 0, 1]);
  face(lift(0), () => [0, 0, -1]);
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): [Vec3, Vec3, Vec3][] => [
    [a, b, c],
    [a, c, d],
  ];
  face(quad([-50, -30, 0], [50, -30, 0], [50, -30, T], [-50, -30, T]), () => [0, -1, 0]);
  face(quad([50, -30, 0], [50, 30, 0], [50, 30, T], [50, -30, T]), () => [1, 0, 0]);
  face(quad([50, 30, 0], [-50, 30, 0], [-50, 30, T], [50, 30, T]), () => [0, 1, 0]);
  face(quad([-50, 30, 0], [-50, -30, 0], [-50, -30, T], [-50, 30, T]), () => [-1, 0, 0]);
  for (const [hx, hy, hr] of spec.holes) {
    const wall: [Vec3, Vec3, Vec3][] = [];
    for (let k = 0; k < seg; k++) {
      const a0 = (2 * Math.PI * k) / seg;
      const a1 = (2 * Math.PI * (k + 1)) / seg;
      const p = (a: number, z: number): Vec3 => [hx + hr * Math.cos(a), hy + hr * Math.sin(a), z];
      wall.push(...quad(p(a0, 0), p(a1, 0), p(a1, T), p(a0, T)));
    }
    // A hole's normals point at its axis (out of the material); OpenCascade's are a little off.
    face(wall, (p) => {
      const d = Math.hypot(p[0] - hx, p[1] - hy) || 1;
      return [-(p[0] - hx) / d, -(p[1] - hy) / d, 0];
    });
  }
  return { name: 'plate', attributes: { position: { array: position }, normal: { array: normal } }, index: { array: index }, brep_faces };
}

/** An importer that reads a JSON plate spec instead of STEP text. */
const importer: IStepImporter = {
  ReadStepFile(content) {
    const spec = JSON.parse(new TextDecoder().decode(content)) as PlateSpec;
    return { success: true, root: { name: 'plate', meshes: [0] }, meshes: [plateMesh(spec)] };
  },
};

const plate = (spec: PlateSpec): Promise<IMesh> => loadMesh(new TextEncoder().encode(JSON.stringify(spec)), { fileName: 'plate.step', step: { importer, deflection: 0.05 } });

const BASE: PlateSpec = { holes: [[-30, 0, 4], [30, 0, 4]], splits: [-15, 15] };

async function diff(b: PlateSpec, t: PlateSpec) {
  const r = diffMeshes(await plate(b), await plate(t), { logger: silent });
  return { r, changes: r.brep!.changes.map((c) => `${c.kind}: ${c.description}`) };
}

describe('the STEP loader keeps the CAD faces', () => {
  it('tags every triangle with its face and fits each face', async () => {
    const mesh = await plate(BASE);
    expect(mesh.brep!.faces.map((f) => describeSurface(f.surface))).toEqual([
      'flat face facing +Z',
      'flat face facing −Z',
      'flat face facing −Y',
      'flat face facing +X',
      'flat face facing +Y',
      'flat face facing −X',
      'hole Ø8',
      'hole Ø8',
    ]);
    expect(mesh.brep!.faceOf.length).toBe(mesh.faceCount);
    expect(Math.min(...mesh.brep!.faceOf)).toBe(0);
    expect(mesh.brep!.faces[0].area).toBeCloseTo(6000 - 2 * 24 * 0.5 * 16 * Math.sin((2 * Math.PI) / 24), 6);
  });
});

describe('face-aware STEP diff', () => {
  it('a re-triangulated model is unchanged', async () => {
    const { r, changes } = await diff(BASE, { ...BASE, splits: [-10, 5] });
    expect(changes).toEqual([]);
    expect(r.brep!.unchanged).toBe(8);
    expect(r.brep!.retriangulated.target).toBeGreaterThan(0);
    expect(r.stats.faces).toMatchObject({ modified: 0, added: 0, removed: 0 });
    expect(r.stats.vertices).toMatchObject({ moved: 0, added: 0, removed: 0 });
  });

  it('a moved hole: named with its move; the flat faces it passes through change outline', async () => {
    const { r, changes } = await diff(BASE, { ...BASE, holes: [[-30, 0, 4], [35, 0, 4]] });
    expect(changes).toEqual(['moved: hole Ø8 moved 5 mm (+5, 0, 0)', 'reshaped: flat face facing +Z: outline changed', 'reshaped: flat face facing −Z: outline changed']);
    expect(r.brep!.changes[0].offset!.map((x) => Number(x.toFixed(9)))).toEqual([5, 0, 0]);
    // The hole's own triangles read as modified, the slivers of the flat faces as added / removed.
    const moved = r.brep!.changes[0].targetFaces[0];
    const t = await plate({ ...BASE, holes: [[-30, 0, 4], [35, 0, 4]] });
    for (let tri = 0; tri < t.faceCount; tri++) if (t.brep!.faceOf[tri] === moved) expect(r.targetFaceStatus[tri]).toBe(FaceStatus.Modified);
    expect(r.stats.faces.added).toBeGreaterThan(0);
    expect(r.stats.faces.removed).toBeGreaterThan(0);
  });

  it('a resized hole', async () => {
    const { r, changes } = await diff(BASE, { ...BASE, holes: [[-30, 0, 4], [30, 0, 4.5]] });
    expect(changes[0]).toBe('resized: hole Ø8 → Ø9');
    expect(r.brep!.changes[0].size!.map((x) => Number(x.toFixed(9)))).toEqual([8, 9]);
  });

  it('a new hole: the flat faces lose its area', async () => {
    const { changes } = await diff(BASE, { holes: [[-30, 0, 4], [30, 0, 4], [0, 15, 3]], splits: [-15, 15] });
    expect(changes[0]).toBe('added: new hole Ø6');
    expect(changes.slice(1)).toEqual([expect.stringMatching(/^reshaped: flat face facing \+Z: outline changed, area [\d.]+ → [\d.]+ mm²$/), expect.stringMatching(/^reshaped: flat face facing −Z/)]);
  });

  it('a removed hole', async () => {
    const { changes } = await diff(BASE, { holes: [[-30, 0, 4]], splits: [-15, 15] });
    expect(changes[0]).toBe('removed: hole Ø8 removed');
  });

  it('a thicker plate: the top face moved up, the walls grew', async () => {
    const { changes } = await diff(BASE, { ...BASE, thickness: 12 });
    expect(changes).toContain('moved: flat face facing +Z moved 2 mm (0, 0, +2)');
    expect(changes.filter((c) => c.startsWith('reshaped: hole Ø8')).length).toBe(2);
    expect(changes.filter((c) => /reshaped: flat face facing [+−][XY]/.test(c)).length).toBe(4);
  });

  it('can be switched off: the triangle-level result stays as it was', async () => {
    const b = await plate(BASE);
    const t = await plate({ ...BASE, splits: [-10, 5] });
    const plain = diffMeshes(b, t, { logger: silent, brepFaces: false });
    expect(plain.brep).toBeUndefined();
    expect(plain.stats.faces.added + plain.stats.faces.removed + plain.stats.faces.modified).toBeGreaterThan(0);
  });
});
