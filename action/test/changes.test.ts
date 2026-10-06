import { describe, expect, it } from 'vitest';
import { modelChanges, modelFormat, parseRawDiff, planWork } from '../lib/changes.mjs';

const Z = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
/** One `git diff --raw -z` record. */
const rec = (oldMode: string, newMode: string, oldBlob: string, newBlob: string, status: string, ...paths: string[]) =>
  `:${oldMode} ${newMode} ${oldBlob} ${newBlob} ${status}\0${paths.join('\0')}\0`;

describe('modelFormat', () => {
  it('matches the four model extensions case-insensitively', () => {
    expect(['a.stl', 'b/C.STL', 'x.Obj', 'm.GLTF', 'scene.glb'].map(modelFormat)).toEqual(['stl', 'stl', 'obj', 'gltf', 'glb']);
  });

  it('reads .step and .stp as STEP', () => {
    expect(['part.step', 'B/PART.STP', 'asm.Step'].map(modelFormat)).toEqual(['step', 'step', 'step']);
  });

  it('ignores everything else', () => {
    expect(['a.stl.bak', 'stl', 'readme.md', 'model.fbx', '', 'dir.stl/file.txt'].map(modelFormat)).toEqual([null, null, null, null, null, null]);
  });
});

describe('parseRawDiff', () => {
  it('reads additions, deletions, modifications and renames, with any character in a name', () => {
    const text =
      rec('000000', '100644', Z, A, 'A', 'new\nline.stl') +
      rec('100644', '000000', A, Z, 'D', 'gone.obj') +
      rec('100644', '100755', A, B, 'M', 'mode and content.glb') +
      rec('100644', '100644', A, A, 'R100', 'old.stl', 'new.stl');
    const e = parseRawDiff(text);
    expect(e.map((x) => [x.status, x.score, x.oldPath, x.path])).toEqual([
      ['A', null, 'new\nline.stl', 'new\nline.stl'],
      ['D', null, 'gone.obj', 'gone.obj'],
      ['M', null, 'mode and content.glb', 'mode and content.glb'],
      ['R', 100, 'old.stl', 'new.stl'],
    ]);
    expect(e[2]).toMatchObject({ oldMode: '100644', newMode: '100755', oldBlob: A, newBlob: B });
  });

  it('accepts empty output and rejects garbage', () => {
    expect(parseRawDiff('')).toEqual([]);
    expect(() => parseRawDiff('not a record\0x\0')).toThrow(/unexpected/);
    expect(() => parseRawDiff(`:100644 100644 ${A} ${B} R090\0only-one-path`)).toThrow(/truncated/);
  });
});

describe('modelChanges', () => {
  it('classifies model files and leaves the rest out, sorted by path', () => {
    const changes = modelChanges(
      parseRawDiff(
        rec('000000', '100644', Z, A, 'A', 'z/added.STL') +
          rec('100644', '000000', A, Z, 'D', 'deleted.obj') +
          rec('100644', '100644', A, B, 'M', 'edited.glb') +
          rec('100644', '100644', A, B, 'R087', 'old.stl', 'renamed.stl') +
          rec('100644', '100644', A, B, 'M', 'README.md'),
      ),
    );
    expect(changes.map((c) => [c.change, c.path, c.oldPath, c.before, c.after, c.identical])).toEqual([
      ['deleted', 'deleted.obj', null, A, null, false],
      ['modified', 'edited.glb', null, A, B, false],
      ['renamed', 'renamed.stl', 'old.stl', A, B, false],
      ['added', 'z/added.STL', null, null, A, false],
    ]);
  });

  it('marks same-content changes: a pure rename, or only the file mode', () => {
    const [rename, mode] = modelChanges(parseRawDiff(rec('100644', '100644', A, A, 'R100', 'a.stl', 'b.stl') + rec('100644', '100755', B, B, 'M', 'c.stl')));
    expect(rename).toMatchObject({ change: 'renamed', identical: true, modeChanged: false });
    expect(mode).toMatchObject({ change: 'modified', identical: true, modeChanged: true });
  });

  it('turns a rename across the model / non-model boundary into an add or a delete', () => {
    const changes = modelChanges(parseRawDiff(rec('100644', '100644', A, B, 'R060', 'notes.txt', 'part.stl') + rec('100644', '100644', A, B, 'R060', 'mesh.obj', 'mesh.obj.bak')));
    expect(changes.map((c) => [c.change, c.path, c.before, c.after])).toEqual([
      ['deleted', 'mesh.obj', A, null],
      ['added', 'part.stl', null, B],
    ]);
  });

  it('skips symbolic links and drops submodules', () => {
    const changes = modelChanges(parseRawDiff(rec('000000', '120000', Z, A, 'A', 'link.stl') + rec('000000', '160000', Z, B, 'A', 'module.obj')));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: 'link.stl', skip: 'a symbolic link, not a file' });
  });
});

describe('planWork', () => {
  it('renders changed files up to the cap and lists the rest; same-content and skipped files are free', () => {
    const c = (path: string, extra = {}) => ({ change: 'modified', path, oldPath: null, before: A, after: B, identical: false, modeChanged: false, skip: null, ...extra });
    const plan = planWork([c('a'), c('b', { identical: true }), c('c', { skip: 'link' }), c('d'), c('e')], 2);
    expect(plan.map((p) => [p.path, p.render, p.overLimit])).toEqual([
      ['a', true, false],
      ['b', false, false],
      ['c', false, false],
      ['d', true, false],
      ['e', false, true],
    ]);
  });
});
