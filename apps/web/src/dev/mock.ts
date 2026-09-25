/**
 * DEV-ONLY mock data (enabled with `?mock=1`, or `?mock=3` for a Tier-3 style rigid
 * alignment). Builds a real IMesh pair with `createMesh` and a hand-computed IDiffResult
 * that follows the status rules documented in types.ts, so the viewer can be developed
 * and smoke-tested before / independently of the real diff engine.
 *
 * Base:   a subdivided, welded cube.
 * Target: same cube with (a) a bump pushed out of the top  -> Moved vertices / Modified faces,
 *         (b) a hole cut into the +X side                   -> Removed vertices + faces,
 *         (c) a pyramid spike raised on the +Z side          -> Added vertex + faces
 *             (the cell under the spike is Removed).
 */
import {
  FaceStatus,
  TIER_NAMES,
  VertexStatus,
  createMesh,
  summarizeMesh,
  transformPoint,
  type IDiffResult,
  type IMesh,
  type ITierAttempt,
  type Mat4,
} from '@polymerge/core';
import * as THREE from 'three';

export interface IMockPair {
  base: IMesh;
  target: IMesh;
  result: IDiffResult;
}

const SEG = 8;
const SIZE = 2;

function buildCube(): { positions: number[]; faces: number[]; grid: Map<string, number> } {
  const grid = new Map<string, number>();
  const positions: number[] = [];
  const faces: number[] = [];
  const vid = (c: [number, number, number]): number => {
    const key = c.join(',');
    let i = grid.get(key);
    if (i === undefined) {
      i = positions.length / 3;
      grid.set(key, i);
      positions.push(...c.map((k) => (k / SEG - 0.5) * SIZE));
    }
    return i;
  };
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      for (let i = 0; i < SEG; i++) {
        for (let j = 0; j < SEG; j++) {
          const corner = (di: number, dj: number): [number, number, number] => {
            const c: [number, number, number] = [0, 0, 0];
            c[axis] = sign > 0 ? SEG : 0;
            c[u] = i + di;
            c[v] = j + dj;
            return c;
          };
          const a = vid(corner(0, 0));
          const b = vid(corner(1, 0));
          const c = vid(corner(1, 1));
          const d = vid(corner(0, 1));
          // u × v = +axis, so (a, b, c) is counter-clockwise seen from +axis.
          if (sign > 0) faces.push(a, b, c, a, c, d);
          else faces.push(a, c, b, a, d, c);
        }
      }
    }
  }
  return { positions, faces, grid };
}

function faceKey(a: number, b: number, c: number): string {
  const s = [a, b, c].sort((x, y) => x - y);
  return s.join(',');
}

function rigidMatrix(): Mat4 {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(1.6, 0.35, -0.9),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.25, 1, 0.15).normalize(), THREE.MathUtils.degToRad(28)),
    new THREE.Vector3(1, 1, 1),
  );
  return Array.from(m.elements);
}

export function createMockPair(variant: 'tier2' | 'tier3' = 'tier2'): IMockPair {
  const t0 = performance.now();
  const cube = buildCube();
  const base = createMesh(cube.positions, cube.faces, {
    metadata: { format: 'obj', sourceName: 'mock_base.obj' },
  });
  const g = (x: number, y: number, z: number) => cube.grid.get(`${x},${y},${z}`)!;

  // (b) hole in the +X side: remove the cells i∈[2,5), j∈[3,6) of that side.
  const removedFaces = new Set<number>();
  const faceSide = (f: number) => Math.floor(f / (SEG * SEG * 2)); // 0..5 = (axis, sign) order
  const cellOf = (f: number) => Math.floor((f % (SEG * SEG * 2)) / 2);
  const PX = 1; // axis 0, sign +1
  for (let f = 0; f < base.faceCount; f++) {
    if (faceSide(f) !== PX) continue;
    const cell = cellOf(f);
    const i = Math.floor(cell / SEG);
    const j = cell % SEG;
    if (i >= 2 && i < 5 && j >= 3 && j < 6) removedFaces.add(f);
  }
  // (c) spike on the +Z side over cell (i=5, j=2): remove the cell, add 4 faces to a new apex.
  const PZ = 5; // axis 2, sign +1
  const spikeCell = 5 * SEG + 2;
  for (let f = 0; f < base.faceCount; f++) {
    if (faceSide(f) === PZ && cellOf(f) === spikeCell) removedFaces.add(f);
  }

  // Vertices only referenced by removed faces disappear from the target.
  const used = new Uint8Array(base.vertexCount);
  for (let f = 0; f < base.faceCount; f++) {
    if (removedFaces.has(f)) continue;
    for (let k = 0; k < 3; k++) used[base.faces[f * 3 + k]] = 1;
  }

  // (a) bump on the top (+Y) side.
  const moved = new Map<number, [number, number, number]>();
  for (let x = 0; x <= SEG; x++) {
    for (let z = 0; z <= SEG; z++) {
      const r = Math.hypot(x - SEG * 0.35, z - SEG * 0.6) / (SEG * 0.3);
      if (r >= 1) continue;
      const v = g(x, SEG, z);
      const p = base.positions;
      const lift = 0.45 * (0.5 + 0.5 * Math.cos(Math.PI * r));
      moved.set(v, [p[v * 3], p[v * 3 + 1] + lift, p[v * 3 + 2]]);
    }
  }

  // Target vertex pool: surviving base vertices (in order) + the spike apex.
  const baseToTarget = new Int32Array(base.vertexCount).fill(-1);
  const tPos: number[] = [];
  for (let v = 0; v < base.vertexCount; v++) {
    if (!used[v]) continue;
    baseToTarget[v] = tPos.length / 3;
    const p = moved.get(v) ?? [base.positions[v * 3], base.positions[v * 3 + 1], base.positions[v * 3 + 2]];
    tPos.push(...p);
  }
  const apex = tPos.length / 3;
  tPos.push((5.5 / SEG - 0.5) * SIZE, (2.5 / SEG - 0.5) * SIZE, SIZE / 2 + 0.55);

  const tFaces: number[] = [];
  for (let f = 0; f < base.faceCount; f++) {
    if (removedFaces.has(f)) continue;
    for (let k = 0; k < 3; k++) tFaces.push(baseToTarget[base.faces[f * 3 + k]]);
  }
  const c00 = baseToTarget[g(5, 2, SEG)];
  const c10 = baseToTarget[g(6, 2, SEG)];
  const c11 = baseToTarget[g(6, 3, SEG)];
  const c01 = baseToTarget[g(5, 3, SEG)];
  tFaces.push(c00, c10, apex, c10, c11, apex, c11, c01, apex, c01, c00, apex);

  const matrix: Mat4 =
    variant === 'tier3' ? rigidMatrix() : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (variant === 'tier3') {
    for (let i = 0; i < tPos.length; i += 3) {
      const q = transformPoint(matrix, [tPos[i], tPos[i + 1], tPos[i + 2]]);
      tPos[i] = q[0];
      tPos[i + 1] = q[1];
      tPos[i + 2] = q[2];
    }
  }
  const target = createMesh(tPos, tFaces, {
    metadata: {
      format: variant === 'tier3' ? 'stl' : 'obj',
      sourceName: variant === 'tier3' ? 'mock_target_scan.stl' : 'mock_target.obj',
      warnings: ['mock data: generated in the browser (?mock), not loaded from a file'],
    },
  });

  // ---- correspondence + statuses (rules from types.ts) ---------------------------
  const targetToBase = new Int32Array(target.vertexCount).fill(-1);
  for (let b = 0; b < base.vertexCount; b++) if (baseToTarget[b] >= 0) targetToBase[baseToTarget[b]] = b;

  const diag = Math.hypot(SIZE, SIZE, SIZE);
  const moveEpsilon = 1e-6 * diag;
  const surfaceTolerance = 0.01 * diag;
  const displacement = new Float32Array(target.vertexCount);
  const targetVertexStatus = new Uint8Array(target.vertexCount);
  const baseVertexStatus = new Uint8Array(base.vertexCount);
  for (let t = 0; t < target.vertexCount; t++) {
    const b = targetToBase[t];
    if (b < 0) {
      targetVertexStatus[t] = VertexStatus.Added;
      continue;
    }
    const from = transformPoint(matrix, [base.positions[b * 3], base.positions[b * 3 + 1], base.positions[b * 3 + 2]]);
    const d = Math.hypot(
      target.positions[t * 3] - from[0],
      target.positions[t * 3 + 1] - from[1],
      target.positions[t * 3 + 2] - from[2],
    );
    // Rigid-transform float noise stays far below the bump heights.
    const eps = variant === 'tier3' ? 1e-4 : moveEpsilon;
    displacement[t] = d > eps ? d : 0;
    targetVertexStatus[t] = d > eps ? VertexStatus.Moved : VertexStatus.Unchanged;
  }
  for (let b = 0; b < base.vertexCount; b++) {
    const t = baseToTarget[b];
    baseVertexStatus[b] = t < 0 ? VertexStatus.Removed : targetVertexStatus[t];
  }

  const baseFaceKeys = new Set<string>();
  for (let f = 0; f < base.faceCount; f++)
    baseFaceKeys.add(faceKey(base.faces[f * 3], base.faces[f * 3 + 1], base.faces[f * 3 + 2]));
  const targetFaceKeysInBase = new Set<string>();
  const targetFaceStatus = new Uint8Array(target.faceCount);
  for (let f = 0; f < target.faceCount; f++) {
    const tv = [target.faces[f * 3], target.faces[f * 3 + 1], target.faces[f * 3 + 2]];
    const bv = tv.map((t) => targetToBase[t]);
    if (bv.some((b) => b < 0)) targetFaceStatus[f] = FaceStatus.Added;
    else {
      const key = faceKey(bv[0], bv[1], bv[2]);
      targetFaceKeysInBase.add(key);
      if (!baseFaceKeys.has(key)) targetFaceStatus[f] = FaceStatus.Added;
      else if (tv.some((t) => targetVertexStatus[t] === VertexStatus.Moved)) targetFaceStatus[f] = FaceStatus.Modified;
      else targetFaceStatus[f] = FaceStatus.Unchanged;
    }
  }
  const baseFaceStatus = new Uint8Array(base.faceCount);
  for (let f = 0; f < base.faceCount; f++) {
    const bv = [base.faces[f * 3], base.faces[f * 3 + 1], base.faces[f * 3 + 2]];
    if (bv.some((b) => baseVertexStatus[b] === VertexStatus.Removed)) baseFaceStatus[f] = FaceStatus.Removed;
    else if (!targetFaceKeysInBase.has(faceKey(bv[0], bv[1], bv[2]))) baseFaceStatus[f] = FaceStatus.Removed;
    else if (bv.some((b) => baseVertexStatus[b] === VertexStatus.Moved)) baseFaceStatus[f] = FaceStatus.Modified;
    else baseFaceStatus[f] = FaceStatus.Unchanged;
  }

  const count = (arr: Uint8Array, code: number) => arr.reduce((n, s) => n + (s === code ? 1 : 0), 0);
  let maxD = 0;
  let sumD = 0;
  let nMoved = 0;
  for (let t = 0; t < target.vertexCount; t++) {
    if (targetVertexStatus[t] !== VertexStatus.Moved) continue;
    maxD = Math.max(maxD, displacement[t]);
    sumD += displacement[t];
    nMoved++;
  }

  const attempt = (tier: 1 | 2 | 3, accepted: boolean, score: number, threshold: number, reason: string, ms: number, metrics: Record<string, number>): ITierAttempt => ({
    tier,
    name: TIER_NAMES[tier],
    accepted,
    score,
    threshold,
    reason,
    durationMs: ms,
    metrics,
  });
  const matchedFraction = (target.vertexCount - 1) / target.vertexCount;
  const attempts: ITierAttempt[] =
    variant === 'tier3'
      ? [
          attempt(1, false, 0.02, 0.95, 'mock: vertex positions share no index lineage (0 of N positions agree)', 0.4, { matchedFraction: 0.02 }),
          attempt(2, false, 0.07, 0.8, 'mock: too few geometric seeds after a rigid move', 3.1, { seeds: 3 }),
          attempt(3, true, 0.93, 0, 'mock: ICP converged; nearest-surface mapping accepted', 18.6, { rms: 0.004, iterations: 23 }),
        ]
      : [
          attempt(1, false, 0.41, 0.95, 'mock: index correspondence breaks after the removed vertices', 0.3, { matchedFraction: 0.41 }),
          attempt(2, true, matchedFraction, 0.8, 'mock: geometric + adjacency matching covers the mesh', 6.2, { matchedFraction }),
        ];
  const tier = attempts[attempts.length - 1].tier;

  const result: IDiffResult = {
    schemaVersion: 1,
    base: summarizeMesh(base),
    target: summarizeMesh(target),
    tier,
    tierName: TIER_NAMES[tier],
    attempts,
    alignment: {
      matrix,
      rmsError: variant === 'tier3' ? 0.004 : 0,
      iterations: variant === 'tier3' ? 23 : 0,
      isIdentity: variant !== 'tier3',
    },
    moveEpsilon,
    surfaceTolerance,
    baseToTarget,
    targetToBase,
    baseVertexStatus,
    targetVertexStatus,
    displacement,
    baseFaceStatus,
    targetFaceStatus,
    stats: {
      vertices: {
        unchanged: count(targetVertexStatus, VertexStatus.Unchanged),
        moved: count(targetVertexStatus, VertexStatus.Moved),
        added: count(targetVertexStatus, VertexStatus.Added),
        removed: count(baseVertexStatus, VertexStatus.Removed),
      },
      faces: {
        unchanged: count(targetFaceStatus, FaceStatus.Unchanged),
        modified: count(targetFaceStatus, FaceStatus.Modified),
        added: count(targetFaceStatus, FaceStatus.Added),
        removed: count(baseFaceStatus, FaceStatus.Removed),
      },
      maxDisplacement: maxD,
      meanDisplacement: nMoved > 0 ? sumD / nMoved : 0,
    },
    durationMs: performance.now() - t0,
  };
  return { base, target, result };
}
