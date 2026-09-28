/**
 * Merge examples built in the browser (no files needed): small base / ours / theirs triples that
 * show each kind of merge outcome. Opened with `?mode=merge&demo=<id>` or the examples list.
 * Deterministic, so the end-to-end tests can rely on their conflicts.
 */
import { createMesh, type IMesh } from 'polymerge-core';

export interface IMergeTriple {
  base: IMesh;
  ours: IMesh;
  theirs: IMesh;
}

export interface IMergeDemo {
  id: string;
  title: string;
  description: string;
  build(): IMergeTriple;
}

type V3 = [number, number, number];

/**
 * A closed n×n slab: top grid at z = t (normals up), bottom grid at z = 0, side walls.
 * Top vertex (i, j) is j·n + i; the bottom one is n² + j·n + i.
 */
function slab(n: number, t: number, name: string): IMesh {
  const top = (i: number, j: number): number => j * n + i;
  const bot = (i: number, j: number): number => n * n + j * n + i;
  const p: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) p.push(i, j, t);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) p.push(i, j, 0);
  const f: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      f.push(top(i, j), top(i + 1, j), top(i + 1, j + 1), top(i, j), top(i + 1, j + 1), top(i, j + 1));
      f.push(bot(i, j), bot(i + 1, j + 1), bot(i + 1, j), bot(i, j), bot(i, j + 1), bot(i + 1, j + 1));
    }
  }
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < n - 1; i++) ring.push([i, 0]);
  for (let j = 0; j < n - 1; j++) ring.push([n - 1, j]);
  for (let i = n - 1; i > 0; i--) ring.push([i, n - 1]);
  for (let j = n - 1; j > 0; j--) ring.push([0, j]);
  ring.forEach(([i0, j0], k) => {
    const [i1, j1] = ring[(k + 1) % ring.length];
    f.push(bot(i0, j0), bot(i1, j1), top(i1, j1), bot(i0, j0), top(i1, j1), top(i0, j0));
  });
  return createMesh(p, f, { metadata: { sourceName: name } });
}

/** Append an axis-aligned box [min, min + size] as a separate part. */
function withBox(m: IMesh, min: V3, size: V3): IMesh {
  const unit = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  const o = m.vertexCount;
  const p = Array.from(m.positions);
  for (let i = 0; i < 8; i++) for (let k = 0; k < 3; k++) p.push(min[k] + unit[i * 3 + k] * size[k]);
  return createMesh(p, [...m.faces, ...faces.map((x) => x + o)], { metadata: m.metadata });
}

/** Copy of `m` with vertices displaced; `moves` maps vertex → offset. */
function moved(m: IMesh, moves: Map<number, V3> | Record<number, V3>, name: string): IMesh {
  const p = Float64Array.from(m.positions);
  const entries = moves instanceof Map ? [...moves] : Object.entries(moves).map(([k, d]) => [Number(k), d] as [number, V3]);
  for (const [v, d] of entries) for (let k = 0; k < 3; k++) p[v * 3 + k] += d[k];
  return createMesh(p, m.faces, { metadata: { ...m.metadata, sourceName: name } });
}

/** The same offset for a set of vertices. */
const all = (verts: number[], d: V3): Map<number, V3> => new Map(verts.map((v) => [v, d]));
const merge = (...maps: Map<number, V3>[]): Map<number, V3> => new Map(maps.flatMap((m) => [...m]));

const N = 9;
const top = (i: number, j: number): number => j * N + i;
const bottom = (i: number, j: number): number => N * N + j * N + i;

export const MERGE_DEMOS: IMergeDemo[] = [
  {
    id: 'thin-wall',
    title: 'Thin wall pushed from both sides',
    description:
      'Ours dents the top of a plate; theirs raises the bottom right under it. Each edit is fine, but together the two surfaces pass through each other — a collision conflict. Elsewhere ours lifts a corner and theirs lowers another: those merge automatically.',
    build: () => {
      const base = slab(N, 1, 'plate.stl');
      return {
        base,
        ours: moved(base, merge(all([top(4, 4)], [0, 0, -0.7]), all([top(0, 0)], [0, 0, 0.4])), 'plate-ours.stl'),
        theirs: moved(base, merge(all([bottom(4, 4)], [0, 0, 0.7]), all([top(8, 8)], [0, 0, -0.4])), 'plate-theirs.stl'),
      };
    },
  },
  {
    id: 'boss-height',
    title: 'Same boss, two heights',
    description:
      'Both sides raise the same 3×3 boss on the plate, to different heights — a move-move conflict. Ours also bevels one corner and theirs another; those merge automatically.',
    build: () => {
      const base = slab(N, 1, 'plate.stl');
      const boss: number[] = [];
      for (let j = 3; j <= 5; j++) for (let i = 3; i <= 5; i++) boss.push(top(i, j));
      return {
        base,
        ours: moved(base, merge(all(boss, [0, 0, 0.8]), all([top(0, 8)], [0.3, -0.3, -0.3])), 'plate-ours.stl'),
        theirs: moved(base, merge(all(boss, [0, 0, 0.4]), all([top(8, 0)], [-0.3, 0.3, -0.3])), 'plate-theirs.stl'),
      };
    },
  },
  {
    id: 'parts',
    title: 'Two blocks moved into one place',
    description:
      'Ours slides block A to the middle of the plate; theirs slides block B to the same place. Each move is fine on its own; merged, the blocks overlap — a collision between two part motions.',
    build: () => {
      const plate = slab(N, 1, 'assembly.stl');
      const base = withBox(withBox(plate, [0.5, 3.5, 1.5], [1.5, 1.5, 1.5]), [6.5, 3.2, 1.5], [1.5, 1.5, 1.5]);
      const a = Array.from({ length: 8 }, (_, i) => plate.vertexCount + i);
      const b = Array.from({ length: 8 }, (_, i) => plate.vertexCount + 8 + i);
      return {
        base,
        ours: moved(base, all(a, [3.2, 0.2, 0.1]), 'assembly-ours.stl'),
        theirs: moved(base, all(b, [-2.9, 0.4, 0.3]), 'assembly-theirs.stl'),
      };
    },
  },
  {
    id: 'mixed-choices',
    title: 'Two choices that clash',
    description:
      'Both sides reshape the top and the bottom of the plate centre, differently: two move-move conflicts. Either side alone is fine — but taking ours for the top and theirs for the bottom pushes the surfaces through each other, and the viewer warns about that combination.',
    build: () => {
      const base = slab(N, 1, 'plate.stl');
      return {
        base,
        ours: moved(base, merge(all([top(4, 4)], [0, 0, -0.7]), all([bottom(4, 4)], [0, 0, 0.1])), 'plate-ours.stl'),
        theirs: moved(base, merge(all([top(4, 4)], [0, 0, -0.1]), all([bottom(4, 4)], [0, 0, 0.7])), 'plate-theirs.stl'),
      };
    },
  },
  {
    id: 'clean',
    title: 'Independent edits (clean)',
    description: 'Ours raises one side of the plate, theirs lowers the other: nothing conflicts, everything merges automatically.',
    build: () => {
      const base = slab(N, 1, 'plate.stl');
      const left: number[] = [];
      const right: number[] = [];
      for (let j = 2; j <= 6; j++) {
        left.push(top(1, j), top(2, j));
        right.push(top(6, j), top(7, j));
      }
      return {
        base,
        ours: moved(base, all(left, [0, 0, 0.5]), 'plate-ours.stl'),
        theirs: moved(base, all(right, [0, 0, -0.5]), 'plate-theirs.stl'),
      };
    },
  },
];

export function findMergeDemo(id: string): IMergeDemo | undefined {
  return MERGE_DEMOS.find((d) => d.id === id);
}
