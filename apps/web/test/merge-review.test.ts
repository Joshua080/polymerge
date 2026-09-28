/**
 * Merge review logic of the viewer (no DOM, no WebGL): which colour class each merged face gets,
 * which conflict a face belongs to, and where the conflict previews are placed — checked on the
 * built-in merge examples, unresolved and resolved.
 */
import { describe, expect, it } from 'vitest';
import { mergeMeshes, resolveMerge, type IMergeResult } from 'polymerge-core';
import * as THREE from 'three';
import { findMergeDemo, MERGE_DEMOS, type IMergeTriple } from '../src/dev/merge-demos.js';
import { conflictGhosts, faceConflicts, mergeFaceKinds, sideToMerged } from '../src/scene/merge-layers.js';
import { mergeView } from '../src/worker/protocol.js';

const silent = { info: () => {}, warn: () => {} };

function run(id: string): { r: IMergeResult; triple: IMergeTriple } {
  const triple = findMergeDemo(id)!.build();
  return { r: mergeMeshes(triple.base, triple.ours, triple.theirs, { logger: silent }), triple };
}

function kindCounts(r: IMergeResult): Record<string, number> {
  const view = mergeView(r);
  const counts: Record<string, number> = {};
  for (const k of mergeFaceKinds(view, faceConflicts(view))) counts[k] = (counts[k] ?? 0) + 1;
  return counts;
}

describe('merge review: face colours', () => {
  it('every example merges and colours every face', () => {
    for (const d of MERGE_DEMOS) {
      const { r } = run(d.id);
      const counts = kindCounts(r);
      expect(Object.values(counts).reduce((a, b) => a + b, 0), d.id).toBe(r.merged.faceCount);
    }
  });

  it('unresolved regions are "conflict"; automatic edits are ours / theirs', () => {
    const { r } = run('thin-wall');
    const counts = kindCounts(r);
    expect(counts.conflict).toBeGreaterThan(0);
    expect(counts.ours).toBeGreaterThan(0);
    expect(counts.theirs).toBeGreaterThan(0);
  });

  it('a resolved region takes the colour of the side it was resolved to', () => {
    const { r } = run('thin-wall');
    const before = kindCounts(r);
    const after = kindCounts(resolveMerge(r, { 0: 'ours' }));
    expect(after.conflict ?? 0).toBe(0);
    expect(after.ours).toBeGreaterThan(before.ours);
  });

  it('a part motion counts as "shaped by" its side (provenance includes part frames)', () => {
    const { r, triple } = run('parts');
    const resolved = resolveMerge(r, { 0: 'ours' });
    const view = mergeView(resolved);
    const kinds = mergeFaceKinds(view, faceConflicts(view));
    // Block A (moved by ours as a part) is the first box after the plate.
    const plateVertices = triple.base.vertexCount - 16;
    const blockA = new Set(Array.from({ length: 8 }, (_, i) => plateVertices + i));
    const m = view.merged;
    let blockFaces = 0;
    for (let f = 0; f < m.faceCount; f++) {
      const corners = [0, 1, 2].map((k) => view.provenance.vertexIndex[m.faces[f * 3 + k]]);
      if (view.provenance.faceSource[f] === 0 && corners.every((v) => blockA.has(v))) {
        blockFaces++;
        expect(kinds[f]).toBe('ours');
      }
    }
    expect(blockFaces).toBe(12);
  });

  it('a clean merge has no conflict faces', () => {
    const counts = kindCounts(run('clean').r);
    expect(counts.conflict ?? 0).toBe(0);
    expect(counts.ours).toBeGreaterThan(0);
    expect(counts.theirs).toBeGreaterThan(0);
  });
});

describe('merge review: conflict previews', () => {
  it('shows each version of the region; ours and theirs differ where they edited', () => {
    const { r, triple } = run('boss-height');
    const view = mergeView(r);
    const ghosts = conflictGhosts(view.conflicts[0], view, triple, new THREE.Vector3());
    expect(ghosts.map((g) => g.label)).toEqual(['base', 'ours', 'theirs']);
    const maxZ = (g: THREE.BufferGeometry): number => {
      g.computeBoundingBox();
      return g.boundingBox!.max.z;
    };
    for (const g of ghosts) expect(g.geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(maxZ(ghosts[0].geometry)).toBeCloseTo(1, 6); // base: flat top
    expect(maxZ(ghosts[1].geometry)).toBeCloseTo(1.8, 6); // ours raised the boss by 0.8
    expect(maxZ(ghosts[2].geometry)).toBeCloseTo(1.4, 6); // theirs by 0.4
  });

  it('maps a side into the merged frame through the base: T_merged · T_side⁻¹', () => {
    const tMerged = new THREE.Matrix4().makeTranslation(1, 0, 0).toArray();
    const tSide = new THREE.Matrix4().makeTranslation(0, 2, 0).toArray();
    const p = new THREE.Vector3(5, 7, 0).applyMatrix4(sideToMerged(tMerged, tSide));
    expect(p.toArray()).toEqual([6, 5, 0]);
  });
});
