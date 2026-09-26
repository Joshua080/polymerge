import { describe, expect, it } from 'vitest';
import { parseDiffOptions } from '../src/commands/diff.js';
import { gitSetupText } from '../src/commands/git.js';
import { decomposeRigid } from '../src/report.js';

describe('decomposeRigid', () => {
  it('recovers angle, axis and translation from a column-major matrix', () => {
    const a = (30 * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // Rotation about +Z, then translate (1, 2, 3). Column-major like three.js Matrix4.elements.
    const m = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];
    const r = decomposeRigid(m);
    expect(r.angleDeg).toBeCloseTo(30, 9);
    expect(r.axis[2]).toBeCloseTo(1, 9);
    expect(r.translation).toEqual([1, 2, 3]);
  });

  it('separates a uniform scale (unit conversion) from the rotation', () => {
    const a = (90 * Math.PI) / 180;
    const k = 25.4;
    const m = [k * Math.cos(a), k * Math.sin(a), 0, 0, -k * Math.sin(a), k * Math.cos(a), 0, 0, 0, 0, k, 0, 5, 0, 0, 1];
    const r = decomposeRigid(m);
    expect(r.scale).toBeCloseTo(25.4, 12);
    expect(r.angleDeg).toBeCloseTo(90, 9);
    expect(r.axis[2]).toBeCloseTo(1, 9);
  });

  it('handles the identity', () => {
    const r = decomposeRigid([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(r.angleDeg).toBe(0);
    expect(r.translation).toEqual([0, 0, 0]);
  });
});

describe('parseDiffOptions', () => {
  it('maps CLI flags onto IDiffOptions', () => {
    const o = parseDiffOptions({ forceTier: '2', moveEpsilon: '0.01', surfaceTolerance: '0.5' }, true);
    expect(o.forceTier).toBe(2);
    expect(o.moveEpsilon).toBe(0.01);
    expect(o.surfaceTolerance).toBe(0.5);
    expect(o.logger).toBeDefined();
  });

  it('rejects bad values', () => {
    expect(() => parseDiffOptions({ forceTier: '4' }, true)).toThrow(/force-tier/);
    expect(() => parseDiffOptions({ moveEpsilon: 'abc' }, true)).toThrow(/move-eps/);
  });
});

describe('gitSetupText', () => {
  it('registers every supported extension and both drivers', () => {
    const t = gitSetupText();
    for (const ext of ['stl', 'obj', 'gltf', 'glb']) expect(t).toContain(`*.${ext} diff=polymerge`);
    expect(t).toContain('diff.polymerge.command "polymerge git-diff"');
    expect(t).toContain('difftool.polymerge.cmd');
  });
});
