/**
 * End-to-end validation of polymerge-core against the known-answer fixtures.
 *
 * For every case in fixtures/manifest.json: load both files with `loadMesh`, diff
 * them with `diffMeshes` (default options, capturing logger), and check the result
 * against the expectations derived by the generator (fixtures/lib/cases.ts) plus
 * the structural invariants of the IDiffResult contract (packages/core/src/types.ts).
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FaceStatus,
  VertexStatus,
  diffMeshes,
  loadMesh,
  type CountExpectation,
  type IDiffLogger,
  type IDiffResult,
  type IFixtureCase,
  type IFixtureManifest,
  type IMesh,
} from '../packages/core/src/index.js';
import { angleBetweenDeg, boundsDiagonal, decomposeSimilarity, distance } from './lib/math.js';
import { countCodes, faceStatusesByContract } from './lib/reference.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8')) as IFixtureManifest;

interface LogLine {
  level: 'info' | 'warn' | 'debug';
  message: string;
}

function expectCount(actual: number, exp: CountExpectation, label: string): void {
  if (typeof exp === 'number') {
    expect(actual, `${label}: expected exactly ${exp}, got ${actual}`).toBe(exp);
  } else {
    expect(actual >= exp[0] && actual <= exp[1], `${label}: expected ${exp[0]}..${exp[1]}, got ${actual}`).toBe(true);
  }
}

function meshPoints(m: IMesh): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < m.vertexCount; i++) out.push([m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]]);
  return out;
}

function extensionFormat(path: string): string {
  return path.split('.').pop()!;
}

function checkMeshContract(m: IMesh, label: string): void {
  expect(m.positions.length, `${label} positions length`).toBe(3 * m.vertexCount);
  expect(m.faces.length, `${label} faces length`).toBe(3 * m.faceCount);
  for (let i = 0; i < m.positions.length; i++) {
    if (Math.fround(m.positions[i]) !== m.positions[i]) throw new Error(`${label}: position component ${i} is not float32-exact`);
  }
  const referenced = new Uint8Array(m.vertexCount);
  for (let f = 0; f < m.faceCount; f++) {
    const a = m.faces[3 * f];
    const b = m.faces[3 * f + 1];
    const c = m.faces[3 * f + 2];
    if (a >= m.vertexCount || b >= m.vertexCount || c >= m.vertexCount) throw new Error(`${label}: face ${f} index out of range`);
    if (a === b || b === c || a === c) throw new Error(`${label}: degenerate face ${f} survived normalisation`);
    referenced[a] = referenced[b] = referenced[c] = 1;
  }
  expect(referenced.every((r) => r === 1), `${label}: every vertex is referenced by a face`).toBe(true);
  // first-appearance order: the first corners of the stream introduce vertices 0, 1, 2, … in sequence
  let next = 0;
  for (let i = 0; i < m.faces.length; i++) {
    if (m.faces[i] > next) throw new Error(`${label}: vertex ${m.faces[i]} appears before vertex ${next} (not first-appearance order)`);
    if (m.faces[i] === next) next++;
  }
  expect(m.groups.length, `${label}: at least one group`).toBeGreaterThan(0);
  let start = 0;
  for (const g of m.groups) {
    expect(g.faceStart, `${label}: groups are contiguous`).toBe(start);
    start += g.faceCount;
  }
  expect(start, `${label}: groups cover every face`).toBe(m.faceCount);
  if (m.vertexIds) expect(m.vertexIds.length, `${label}: vertexIds length`).toBe(m.vertexCount);
}

describe.each(manifest.cases)('e2e $id', (fc: IFixtureCase) => {
  let base: IMesh;
  let target: IMesh;
  let result: IDiffResult;
  const logs: LogLine[] = [];

  beforeAll(async () => {
    base = await loadMesh(readFileSync(join(here, fc.base)), { fileName: basename(fc.base) });
    target = await loadMesh(readFileSync(join(here, fc.target)), { fileName: basename(fc.target) });
    const logger: IDiffLogger = {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      debug: (message) => logs.push({ level: 'debug', message }),
    };
    result = diffMeshes(base, target, { logger });
  });

  it('normalises both files to the expected welded sizes', () => {
    expect({ vertexCount: base.vertexCount, faceCount: base.faceCount }, 'base mesh').toEqual(fc.expect.baseMesh);
    expect({ vertexCount: target.vertexCount, faceCount: target.faceCount }, 'target mesh').toEqual(fc.expect.targetMesh);
    expect(base.metadata.format).toBe(extensionFormat(fc.base));
    expect(target.metadata.format).toBe(extensionFormat(fc.target));
    checkMeshContract(base, 'base');
    checkMeshContract(target, 'target');
  });

  it('resolves in an acceptable tier, after trying tiers in order', () => {
    expect(fc.expect.acceptableTiers, `resolved in Tier ${result.tier}`).toContain(result.tier);
    const attempts = result.attempts;
    expect(attempts.length).toBeGreaterThan(0);
    const last = attempts[attempts.length - 1];
    expect(last.tier).toBe(result.tier);
    expect(last.accepted).toBe(true);
    for (let i = 0; i < attempts.length - 1; i++) {
      expect(attempts[i].accepted, `attempt ${i} (Tier ${attempts[i].tier}) was not accepted`).toBe(false);
      expect(attempts[i + 1].tier).toBeGreaterThan(attempts[i].tier);
    }
    expect(result.tierName).toContain(`Tier ${result.tier}`);
  });

  it('reports the expected vertex counts', () => {
    for (const [key, exp] of Object.entries(fc.expect.vertices ?? {})) {
      expectCount(result.stats.vertices[key as keyof IDiffResult['stats']['vertices']], exp, `vertices.${key}`);
    }
  });

  it('reports the expected face counts', () => {
    for (const [key, exp] of Object.entries(fc.expect.faces ?? {})) {
      expectCount(result.stats.faces[key as keyof IDiffResult['stats']['faces']], exp, `faces.${key}`);
    }
  });

  it('honours every mustMatch correspondence', () => {
    const wrong: string[] = [];
    for (const [b, t] of fc.expect.mustMatch ?? []) {
      if (result.targetToBase[t] !== b || result.baseToTarget[b] !== t) {
        wrong.push(`base ${b} ↔ target ${t} (got targetToBase[${t}]=${result.targetToBase[t]}, baseToTarget[${b}]=${result.baseToTarget[b]})`);
      }
    }
    expect(wrong.slice(0, 10), `${wrong.length} of ${(fc.expect.mustMatch ?? []).length} pairs wrong`).toEqual([]);
  });

  it.runIf(fc.expect.alignment !== undefined)('recovers the known alignment (rotation, translation, scale, units)', () => {
    const a = fc.expect.alignment!;
    const m = result.alignment.matrix;
    expect(m).toHaveLength(16);
    const d = decomposeSimilarity(m);
    expect(d.orthonormalityError, 'rotation part is orthonormal').toBeLessThan(1e-6);
    expect(d.determinant, 'rotation is proper').toBeCloseTo(1, 6);
    const dt = distance(d.translation, a.translation);
    expect(dt, `translation ${d.translation.map((x) => x.toFixed(4))} vs ${a.translation}`).toBeLessThanOrEqual(a.tolerance);
    expect(Math.abs(d.angleDeg - a.rotationDeg), `angle ${d.angleDeg.toFixed(4)}° vs ${a.rotationDeg}°`).toBeLessThanOrEqual(a.tolerance);
    if (a.rotationDeg > a.tolerance) {
      expect(angleBetweenDeg(d.axis, a.rotationAxis), `axis ${d.axis.map((x) => x.toFixed(4))} vs ${a.rotationAxis}`).toBeLessThanOrEqual(
        a.tolerance,
      );
    }
    const scale = a.scale ?? 1;
    expect(Math.abs(d.scale / scale - 1), `scale ${d.scale} vs ${scale}`).toBeLessThanOrEqual(a.tolerance);
    expect(Math.abs(result.alignment.scale / scale - 1), 'alignment.scale').toBeLessThanOrEqual(a.tolerance);
    if (a.units) expect(result.alignment.units).toEqual(a.units);
    else expect(result.alignment.units).toBeUndefined();
    expect(result.alignment.isIdentity).toBe(false);
  });

  it.runIf(fc.expect.parts !== undefined)('reports the expected number of moved parts', () => {
    expectCount(result.parts.length, fc.expect.parts!, 'parts');
  });

  it('satisfies the IDiffResult structural invariants', () => {
    const r = result;
    const nb = base.vertexCount;
    const nt = target.vertexCount;
    const tier = r.tier;
    expect(r.schemaVersion).toBe(1);
    expect([r.base.vertexCount, r.base.faceCount, r.target.vertexCount, r.target.faceCount]).toEqual([
      nb,
      base.faceCount,
      nt,
      target.faceCount,
    ]);
    expect(r.baseToTarget).toHaveLength(nb);
    expect(r.targetToBase).toHaveLength(nt);
    expect(r.baseVertexStatus).toHaveLength(nb);
    expect(r.targetVertexStatus).toHaveLength(nt);
    expect(r.displacement).toHaveLength(nt);
    expect(r.baseFaceStatus).toHaveLength(base.faceCount);
    expect(r.targetFaceStatus).toHaveLength(target.faceCount);

    // resolved default epsilons (no options passed): 1e-6 × / 1% of the larger bounds diagonal
    const diag = Math.max(boundsDiagonal(meshPoints(base)), boundsDiagonal(meshPoints(target)));
    expect(Math.abs(r.moveEpsilon - 1e-6 * diag), 'default moveEpsilon').toBeLessThanOrEqual(1e-9 * diag);
    expect(Math.abs(r.surfaceTolerance - 0.01 * diag), 'default surfaceTolerance').toBeLessThanOrEqual(1e-9 * diag);

    const problems: string[] = [];
    const note = (msg: string) => {
      if (problems.length < 10) problems.push(msg);
    };
    // mapping ranges and consistency
    for (let b = 0; b < nb; b++) {
      const t = r.baseToTarget[b];
      if (t < -1 || t >= nt) note(`baseToTarget[${b}] = ${t} out of range`);
      else if (t >= 0 && r.targetToBase[t] !== b) note(`baseToTarget[${b}] = ${t} but targetToBase[${t}] = ${r.targetToBase[t]}`);
      const s = r.baseVertexStatus[b];
      if (s !== VertexStatus.Unchanged && s !== VertexStatus.Moved && s !== VertexStatus.Removed) note(`baseVertexStatus[${b}] = ${s}`);
      if (tier !== 3) {
        if ((t < 0) !== (s === VertexStatus.Removed)) note(`base ${b}: mapped to ${t} but status ${s}`);
        if (t >= 0 && s !== r.targetVertexStatus[t]) note(`base ${b} status ${s} ≠ its match ${t} status ${r.targetVertexStatus[t]}`);
      }
    }
    for (let t = 0; t < nt; t++) {
      const b = r.targetToBase[t];
      if (b < -1 || b >= nb) note(`targetToBase[${t}] = ${b} out of range`);
      else if (tier !== 3 && b >= 0 && r.baseToTarget[b] !== t) note(`not a bijection: targetToBase[${t}] = ${b}, baseToTarget[${b}] = ${r.baseToTarget[b]}`);
      const s = r.targetVertexStatus[t];
      const d = r.displacement[t];
      if (s !== VertexStatus.Unchanged && s !== VertexStatus.Moved && s !== VertexStatus.Added) note(`targetVertexStatus[${t}] = ${s}`);
      if (b < 0 && s !== VertexStatus.Added) note(`target ${t} unmatched but status ${s}`);
      if (tier !== 3 && b >= 0 && s === VertexStatus.Added) note(`target ${t} matched to ${b} but Added`);
      if (!(d >= 0) || !Number.isFinite(d)) note(`displacement[${t}] = ${d}`);
      if (s === VertexStatus.Added && d !== 0) note(`Added target ${t} has displacement ${d}`);
      if (s === VertexStatus.Unchanged && d > r.moveEpsilon * (1 + 1e-6)) note(`Unchanged target ${t} displaced ${d} > moveEpsilon`);
      if (s === VertexStatus.Moved && d < r.moveEpsilon * (1 - 1e-6)) note(`Moved target ${t} displaced only ${d}`);
      if (tier === 3 && s === VertexStatus.Moved && d > r.surfaceTolerance * (1 + 1e-6)) note(`Moved target ${t} beyond surfaceTolerance`);
    }
    // face statuses follow the contract rules from the vertex correspondence
    const fs = faceStatusesByContract(
      base.faces,
      target.faces,
      r.baseToTarget,
      r.targetToBase,
      r.baseVertexStatus,
      r.targetVertexStatus,
      tier !== 3,
    );
    for (let f = 0; f < base.faceCount; f++) {
      if (r.baseFaceStatus[f] !== fs.base[f]) note(`baseFaceStatus[${f}] = ${r.baseFaceStatus[f]}, contract rules give ${fs.base[f]}`);
    }
    for (let f = 0; f < target.faceCount; f++) {
      if (r.targetFaceStatus[f] !== fs.target[f]) note(`targetFaceStatus[${f}] = ${r.targetFaceStatus[f]}, contract rules give ${fs.target[f]}`);
    }
    expect(problems).toEqual([]);

    // stats agree with the status arrays
    const tv = countCodes(r.targetVertexStatus);
    const bv = countCodes(r.baseVertexStatus);
    const tf = countCodes(r.targetFaceStatus);
    const bf = countCodes(r.baseFaceStatus);
    const sv = r.stats.vertices;
    const sf = r.stats.faces;
    expect(sv.added, 'stats.vertices.added').toBe(tv[VertexStatus.Added]);
    expect(sv.removed, 'stats.vertices.removed').toBe(bv[VertexStatus.Removed]);
    expect(sf.added, 'stats.faces.added').toBe(tf[FaceStatus.Added]);
    expect(sf.removed, 'stats.faces.removed').toBe(bf[FaceStatus.Removed]);
    if (tier !== 3) {
      // one-to-one matching ⇒ both sides agree
      expect([sv.unchanged, sv.moved], 'stats.vertices unchanged/moved').toEqual([tv[0], tv[1]]);
      expect([bv[0], bv[1]], 'base vs target vertex statuses').toEqual([tv[0], tv[1]]);
      expect([sf.unchanged, sf.modified], 'stats.faces unchanged/modified').toEqual([tf[0], tf[1]]);
      expect([bf[0], bf[1]], 'base vs target face statuses').toEqual([tf[0], tf[1]]);
    } else {
      expect([[tv[0], tv[1]], [bv[0], bv[1]]], 'stats.vertices unchanged/moved (either side)').toContainEqual([sv.unchanged, sv.moved]);
      expect([[tf[0], tf[1]], [bf[0], bf[1]]], 'stats.faces unchanged/modified (either side)').toContainEqual([sf.unchanged, sf.modified]);
    }
    let max = 0;
    let sum = 0;
    for (let t = 0; t < nt; t++) {
      if (r.targetVertexStatus[t] !== VertexStatus.Moved) continue;
      max = Math.max(max, r.displacement[t]);
      sum += r.displacement[t];
    }
    const mean = tv[VertexStatus.Moved] ? sum / tv[VertexStatus.Moved] : 0;
    expect(Math.abs(r.stats.maxDisplacement - max), 'stats.maxDisplacement').toBeLessThanOrEqual(1e-6 * Math.max(1, max));
    expect(Math.abs(r.stats.meanDisplacement - mean), 'stats.meanDisplacement').toBeLessThanOrEqual(1e-6 * Math.max(1, mean));

    // alignment: the identity, or (Tier 3 / a Tier 1-2 global transform) a proper similarity
    const m = r.alignment.matrix;
    expect(m).toHaveLength(16);
    expect(m.every((x) => Number.isFinite(x))).toBe(true);
    expect(Math.abs(m[3]) + Math.abs(m[7]) + Math.abs(m[11]) + Math.abs(m[15] - 1), 'affine bottom row').toBeLessThanOrEqual(1e-12);
    if (r.alignment.isIdentity && tier !== 3) {
      expect(Math.abs(r.alignment.rmsError)).toBe(0);
      expect(r.alignment.scale).toBe(1);
      expect(m.map((x, i) => Math.abs(x - (i % 5 === 0 ? 1 : 0))).every((e) => e <= 1e-12)).toBe(true);
    } else {
      const d = decomposeSimilarity(m);
      expect(d.orthonormalityError).toBeLessThan(1e-6);
      expect(d.determinant).toBeCloseTo(1, 6);
      expect(d.scale / r.alignment.scale).toBeCloseTo(1, 9);
      expect(r.alignment.rmsError).toBeGreaterThanOrEqual(0);
    }
    for (const p of r.parts) {
      expect(p.baseVertices.length + p.targetVertices.length).toBeGreaterThan(0);
      expect(p.matchedVertices).toBeLessThanOrEqual(Math.min(p.baseVertices.length, p.targetVertices.length) + p.targetVertices.length);
      expect(p.matrix).toHaveLength(16);
    }
  });

  it('logs every tier attempt and a line naming the resolved tier', () => {
    const lines = logs.map((l) => l.message);
    const info = logs.filter((l) => l.level === 'info');
    expect(info.length).toBeGreaterThanOrEqual(result.attempts.length);
    for (const a of result.attempts) {
      expect(lines.some((l) => new RegExp(`Tier\\s*${a.tier}\\b`, 'i').test(l)), `a line mentions Tier ${a.tier}`).toBe(true);
    }
    const resolved = lines.filter((l) => new RegExp(`Tier\\s*${result.tier}\\b`, 'i').test(l) && /resolved/i.test(l));
    expect(resolved.length, `no log line names the resolved Tier ${result.tier}:\n${lines.join('\n')}`).toBeGreaterThan(0);
  });
});
