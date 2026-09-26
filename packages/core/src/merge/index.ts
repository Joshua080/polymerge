/**
 * THREE-WAY MERGE — public API. Semantics: docs/merge-design.md.
 *
 *   mergeMeshes(base, ours, theirs, options)  → IMergeResult
 *   resolveMerge(result, resolutions)          → IMergeResult with those conflicts resolved
 *
 * Both diffs (base → ours, base → theirs) run with the regular tiered engine, so the merge
 * log states which tier resolved each side. Every non-conflicting change is applied; each
 * conflict region stays in its BASE state until a resolution chooses 'ours' / 'theirs'.
 */
import { buildComponents } from '../diff/components.js';
import { diffMeshes } from '../diff/engine.js';
import { FaceSet } from '../diff/faceset.js';
import { applyRigid, rigidToMat4, type IRigid } from '../diff/linalg.js';
import type {
  IDiffLogger,
  IMergeConflict,
  IMergeOptions,
  IMergeResult,
  IMesh,
  MergeConflictKind,
  MergeMeshesFn,
  MergeResolution,
} from '../types.js';
import { materialize, type IResolutions } from './materialize.js';
import { buildPlan, type IMergePlan, type IRegion } from './plan.js';
import { decomposeSide } from './sides.js';

const now: () => number =
  typeof globalThis.performance?.now === 'function' ? () => globalThis.performance.now() : () => Date.now();

/** Plans kept for resolveMerge (not serialisable, not part of the contract). */
const PLANS = new WeakMap<IMergeResult, IMergePlan>();

const KIND_TEXT: Record<MergeConflictKind, (n: number) => string> = {
  'move-move': (n) => `${n} vertex(es) moved to different places by ours and theirs`,
  'move-delete': (n) => `${n} vertex(es) moved by one side but deleted by the other`,
  'delete-dependency': (n) => `${n} vertex(es) deleted by one side while the other side's new geometry is attached to them`,
  'competing-additions': (n) => `both sides added different faces on the same edges (${n})`,
  'overlapping-additions': (n) => `new geometry from both sides overlaps in space (${n} place(s))`,
  'part-motion': (n) => `both sides moved the same part differently (${n})`,
  'global-transform': () => 'both sides transformed the whole model differently',
  lineage: () => 'vertex identity was lost on one side, so edits cannot be merged vertex by vertex',
};

function regionMessage(r: IRegion): string {
  const parts = (Object.keys(r.kinds) as MergeConflictKind[]).map((k) => KIND_TEXT[k](r.kinds[k]!));
  return parts.join('; ') + (r.details.length ? ` — ${r.details.join('; ')}` : '');
}

function buildConflicts(plan: IMergePlan, global: IRigid): IMergeConflict[] {
  const out: IMergeConflict[] = [];
  const { base, ours, theirs } = plan;
  const q = new Float64Array(3);
  if (plan.lineage !== null) {
    const c = base.metadata.bounds;
    out.push({
      id: 0,
      kinds: { lineage: 1 },
      message: `${KIND_TEXT.lineage(1)}: ${plan.lineage}. Resolve by taking one whole side.`,
      baseVertices: new Uint32Array(0),
      baseFaces: new Uint32Array(0),
      oursVertices: new Uint32Array(0),
      theirsVertices: new Uint32Array(0),
      focus: [0.5 * (c.min[0] + c.max[0]), 0.5 * (c.min[1] + c.max[1]), 0.5 * (c.min[2] + c.max[2])],
      resolution: null,
      wholeModel: true,
    });
    return out;
  }
  const bp = base.positions;
  for (const r of plan.regions) {
    const inRegion = new Uint8Array(base.vertexCount);
    for (const v of r.baseVertices) inRegion[v] = 1;
    const faces: number[] = [];
    for (let f = 0; f < base.faceCount; f++) {
      if (inRegion[base.faces[f * 3]] || inRegion[base.faces[f * 3 + 1]] || inRegion[base.faces[f * 3 + 2]]) faces.push(f);
    }
    const sideVerts = (side: typeof ours, sideFaces: number[]): Uint32Array => {
      const set = new Set<number>();
      for (const v of r.baseVertices) if (side.map[v] >= 0) set.add(side.map[v]);
      for (const f of sideFaces) for (let k = 0; k < 3; k++) set.add(side.mesh.faces[f * 3 + k]);
      return Uint32Array.from([...set].sort((a, b) => a - b));
    };
    let fx = 0;
    let fy = 0;
    let fz = 0;
    let n = 0;
    for (const v of r.baseVertices) {
      applyRigid(global, bp[v * 3], bp[v * 3 + 1], bp[v * 3 + 2], q);
      fx += q[0];
      fy += q[1];
      fz += q[2];
      n++;
    }
    const addFocus = (side: typeof ours, pos: Float64Array, faceList: number[]): void => {
      for (const f of faceList) {
        for (let k = 0; k < 3; k++) {
          const t = side.mesh.faces[f * 3 + k];
          if (side.inv[t] >= 0) continue;
          applyRigid(global, pos[t * 3], pos[t * 3 + 1], pos[t * 3 + 2], q);
          fx += q[0];
          fy += q[1];
          fz += q[2];
          n++;
        }
      }
    };
    if (n === 0) {
      addFocus(ours, plan.oursAddedPos, r.oursFaces);
      addFocus(theirs, plan.theirsAddedPos, r.theirsFaces);
    }
    out.push({
      id: r.id,
      kinds: { ...r.kinds },
      message: regionMessage(r),
      baseVertices: Uint32Array.from(r.baseVertices),
      baseFaces: Uint32Array.from(faces),
      oursVertices: sideVerts(ours, r.oursFaces),
      theirsVertices: sideVerts(theirs, r.theirsFaces),
      focus: n > 0 ? [fx / n, fy / n, fz / n] : [0, 0, 0],
      resolution: null,
      wholeModel: false,
    });
  }
  if (plan.global.source === 'conflict') {
    const c = base.metadata.bounds;
    out.push({
      id: out.length,
      kinds: { 'global-transform': 1 },
      message: `${KIND_TEXT['global-transform'](1)} (ours: ${describe(plan.global.ours)}; theirs: ${describe(plan.global.theirs)}). Local edits are still merged; choose which whole-model transform to keep.`,
      baseVertices: new Uint32Array(0),
      baseFaces: new Uint32Array(0),
      oursVertices: new Uint32Array(0),
      theirsVertices: new Uint32Array(0),
      focus: [0.5 * (c.min[0] + c.max[0]), 0.5 * (c.min[1] + c.max[1]), 0.5 * (c.min[2] + c.max[2])],
      resolution: null,
      wholeModel: true,
    });
  }
  return out;
}

function describe(g: IRigid): string {
  const angle = Math.atan2(0.5 * Math.hypot(g.r[7] - g.r[5], g.r[2] - g.r[6], g.r[3] - g.r[1]), 0.5 * (g.r[0] + g.r[4] + g.r[8] - 1));
  const mag = Math.max(1, ...Array.from(g.t, Math.abs));
  const t = Array.from(g.t, (x) => (Math.abs(x) < 1e-9 * mag ? 0 : Number(x.toPrecision(4))));
  const scale = Math.abs(g.s - 1) > 1e-9 ? `scale ×${Number(g.s.toPrecision(6))}, ` : '';
  return `${scale}rotation ${((angle * 180) / Math.PI).toFixed(1)}°, translation (${t.join(', ')})`;
}

function assemble(
  plan: IMergePlan,
  resolutions: Record<number, MergeResolution>,
  defaultResolution: MergeResolution | null,
  t0: number,
  logger: IDiffLogger | null,
): IMergeResult {
  // Conflict ids: regions (0..R−1), then the global-transform conflict; lineage alone is id 0.
  const provisional = buildConflicts(plan, plan.global.merged ?? plan.global.ours);
  const choiceOf = (id: number): MergeResolution | null => resolutions[id] ?? defaultResolution ?? null;
  const globalConflict = provisional.find((c) => c.kinds['global-transform']);
  const res: IResolutions = {
    region: (id) => (id >= 0 && id < plan.regions.length ? choiceOf(id) : null),
    global: globalConflict ? choiceOf(globalConflict.id) : null,
    lineage: plan.lineage !== null ? choiceOf(0) : null,
  };
  const m = materialize(plan, res);
  const conflicts = buildConflicts(plan, m.global).map((c) => ({ ...c, resolution: choiceOf(c.id) }));
  const unresolved = conflicts.filter((c) => c.resolution === null).length;
  const isIdentity = plan.global.source === 'base' || (plan.global.source === 'conflict' && res.global !== 'ours' && res.global !== 'theirs');
  const units =
    plan.global.source === 'ours' || (plan.global.source === 'conflict' && res.global === 'ours')
      ? plan.ours.diff.alignment.units
      : plan.global.source === 'theirs' || (plan.global.source === 'conflict' && res.global === 'theirs')
        ? plan.theirs.diff.alignment.units
        : plan.global.source === 'both'
          ? plan.ours.diff.alignment.units
          : plan.global.source === 'composed'
            ? (plan.ours.unitOnly ? plan.ours : plan.theirs).diff.alignment.units
            : undefined;
  const result: IMergeResult = {
    merged: m.mesh,
    clean: unresolved === 0,
    conflicts,
    stats: { ...m.stats, conflicts: conflicts.length, unresolved },
    frame: {
      source: plan.global.source,
      transform: {
        matrix: rigidToMat4(m.global),
        scale: m.global.s,
        ...(units ? { units } : {}),
        rmsError: 0,
        iterations: 0,
        isIdentity,
      },
    },
    provenance: m.provenance,
    ours: plan.ours.diff,
    theirs: plan.theirs.diff,
    durationMs: now() - t0,
  };
  PLANS.set(result, plan);
  if (logger) {
    const s = result.stats;
    logger.info(
      `[polymerge] merge: auto-applied ${s.movedFromOurs + s.deletedFromOurs + s.facesAddedFromOurs} change(s) from ours, ` +
        `${s.movedFromTheirs + s.deletedFromTheirs + s.facesAddedFromTheirs} from theirs, ` +
        `${s.movedConvergent + s.deletedConvergent + s.facesAddedConvergent} identical on both; ` +
        `${conflicts.length} conflict(s)${unresolved > 0 ? `, ${unresolved} unresolved (left in base state)` : ''}`,
    );
    for (const c of conflicts) {
      logger.info(`[polymerge]   conflict #${c.id}${c.resolution ? ` → ${c.resolution}` : ''}: ${c.message}`);
    }
  }
  return result;
}

export const mergeMeshes: MergeMeshesFn = (base: IMesh, ours: IMesh, theirs: IMesh, options: IMergeOptions = {}): IMergeResult => {
  const t0 = now();
  const logger = options.logger ?? console;
  const diffOptions = { ...options.diff, logger: options.diff?.logger ?? logger };
  logger.info('[polymerge] merge: diffing base → ours');
  const dA = diffMeshes(base, ours, diffOptions);
  logger.info('[polymerge] merge: diffing base → theirs');
  const dB = diffMeshes(base, theirs, diffOptions);
  logger.info(`[polymerge] merge: ours resolved by Tier ${dA.tier}, theirs by Tier ${dB.tier}`);
  const baseComponents = buildComponents(base.vertexCount, base.faces);
  const baseFaceSet = new FaceSet(base.faces);
  const sideA = decomposeSide('ours', base, ours, dA, baseComponents, baseFaceSet);
  const sideB = decomposeSide('theirs', base, theirs, dB, baseComponents, baseFaceSet);
  const plan = buildPlan(base, sideA, sideB, baseComponents);
  return assemble(plan, options.resolutions ?? {}, options.defaultResolution ?? null, t0, logger);
};

/** Re-materialise a merge with (additional) resolutions, without recomputing the diffs. */
export function resolveMerge(
  result: IMergeResult,
  resolutions: Record<number, MergeResolution>,
  options: { defaultResolution?: MergeResolution | null; logger?: IDiffLogger | null } = {},
): IMergeResult {
  const plan = PLANS.get(result);
  if (!plan) throw new Error('resolveMerge: this result was not produced by mergeMeshes in this process');
  const merged: Record<number, MergeResolution> = {};
  for (const c of result.conflicts) if (c.resolution) merged[c.id] = c.resolution;
  Object.assign(merged, resolutions);
  for (const id of Object.keys(resolutions)) {
    if (!result.conflicts.some((c) => c.id === Number(id))) throw new RangeError(`resolveMerge: no conflict #${id}`);
  }
  return assemble(plan, merged, options.defaultResolution ?? null, now(), options.logger === undefined ? null : options.logger);
}
