/**
 * `polymerge log`: a model's versions from git — renames followed, deletions and uncommitted
 * changes included, .gltf files read with their .bin from the same commit, steps cached in the
 * git directory — and the page the viewer shows them with.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packPage, unpackPage } from 'polymerge-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { historyPage, stepSummary } from '../src/commands/log.js';
import { modelHistory } from '../src/history.js';
import { palette } from '../src/report.js';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
const roots: string[] = [];

function repo(): { dir: string; git: (...args: string[]) => string; write: (rel: string, data: string | Uint8Array) => void; commit: (msg: string) => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-log-')));
  roots.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  return {
    dir,
    git,
    write: (rel, data) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), data);
    },
    commit: (msg) => {
      git('add', '-A');
      git('commit', '-q', '-m', msg);
    },
  };
}

/** A 10 × 10 grid plate as OBJ; `lift` raises vertex (i, j) → z. */
function plate(lift: Record<string, number> = {}, n = 10): string {
  const lines: string[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) lines.push(`v ${i} ${j} ${lift[`${i},${j}`] ?? 0}`);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i + 1;
      lines.push(`f ${a} ${a + 1} ${a + n + 2}`, `f ${a} ${a + n + 2} ${a + n + 1}`);
    }
  return lines.join('\n') + '\n';
}

const opts = { engine: 'test', max: 20 };

afterAll(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

describe('modelHistory', () => {
  let r: ReturnType<typeof repo>;
  beforeAll(() => {
    r = repo();
    r.write('models/plate.obj', plate());
    r.commit('first plate');
    r.write('models/plate.obj', plate({ '5,5': 0.8 }));
    r.commit('raise the middle');
    r.git('mv', 'models/plate.obj', 'models/base-plate.obj');
    r.commit('rename');
    r.write('models/base-plate.obj', plate({ '5,5': 0.8, '1,1': -0.5 }));
  });

  it('lists every version newest first, following the rename, with the uncommitted change on top', async () => {
    const h = await modelHistory(path.join(r.dir, 'models/base-plate.obj'), { ...opts, cache: false });
    expect(h.rel).toBe('models/base-plate.obj');
    expect(h.entries.map((e) => [e.status, e.subject, e.step.kind])).toEqual([
      ['W', 'uncommitted changes', 'modified'],
      ['R', 'rename', 'unchanged'],
      ['M', 'raise the middle', 'modified'],
      ['A', 'first plate', 'added'],
    ]);
    expect(h.entries[1].from).toBe('models/plate.obj');
    expect(h.entries[2].path).toBe('models/plate.obj');
    expect(h.entries[2].step.stats!.vertices.moved).toBe(1);
    expect(h.entries[2].step.stats!.maxDisplacement).toBeCloseTo(0.8, 6);
    expect(h.entries[0].step.stats!.vertices.moved).toBe(1);
    expect(h.entries[3].step.model!.faces).toBe(200);
  });

  it('--committed leaves the working tree out; --max limits the commits', async () => {
    const h = await modelHistory(path.join(r.dir, 'models/base-plate.obj'), { ...opts, cache: false, committedOnly: true, max: 2 });
    expect(h.entries.map((e) => e.subject)).toEqual(['rename', 'raise the middle']);
    // The oldest shown version has nothing older loaded to compare with.
    expect(h.entries[1].step.kind).toBe('added');
  });

  it('reads the summary lines a person sees', async () => {
    const h = await modelHistory(path.join(r.dir, 'models/base-plate.obj'), { ...opts, cache: false });
    const plain = palette({ isTTY: false } as NodeJS.WriteStream);
    expect(stepSummary(h.entries[2].step, plain)[0]).toMatch(/^~ 1 vertex moved \(largest 0\.8\)/);
    expect(stepSummary(h.entries[1].step, plain)).toEqual(['= no change to the model']);
    expect(stepSummary(h.entries[3].step, plain)[0]).toMatch(/^\+ added: 200 faces/);
  });

  it('caches each step in the git directory, keyed by the two versions', async () => {
    const file = path.join(r.dir, 'models/base-plate.obj');
    await modelHistory(file, { ...opts, committedOnly: true });
    const dir = path.join(r.dir, '.git/polymerge/log');
    const cached = fs.readdirSync(dir).filter((f) => f.startsWith('test-'));
    expect(cached).toHaveLength(3);
    // A second run reads the cache: a planted step comes back as is.
    const first = r.git('rev-parse', 'HEAD~2:models/plate.obj').trim();
    const middle = r.git('rev-parse', 'HEAD~1:models/plate.obj').trim();
    const key = `test-${first}-${middle}.json`;
    expect(cached).toContain(key);
    fs.writeFileSync(path.join(dir, key), JSON.stringify({ kind: 'unreadable', error: 'from the cache' }));
    const h = await modelHistory(file, { ...opts, committedOnly: true });
    expect(h.entries[1].step.error).toBe('from the cache');
    // Another engine version does not reuse it.
    const other = await modelHistory(file, { ...opts, committedOnly: true, engine: 'other' });
    expect(other.entries[1].step.kind).toBe('modified');
  });

  it('builds a viewer page: every model once, the diff between consecutive versions', async () => {
    const h = await modelHistory(path.join(r.dir, 'models/base-plate.obj'), { ...opts, cache: false }, true);
    const page = unpackPage(packPage(historyPage(h, 'polymerge test')));
    expect(page.models).toHaveLength(4);
    expect(page.results.map((x) => [x.base, x.target])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(page.history!.file).toBe('models/base-plate.obj');
    expect(page.history!.versions.map((v) => v.status)).toEqual(['W', 'R', 'M', 'A']);
    expect(page.history!.versions[2].summary[0]).toMatch(/^~ 1 vertex moved/);
  });
});

describe('modelHistory — deletions, unreadable versions, .gltf', () => {
  it('a deleted and re-added file: the deletion is a version, the re-add compares with nothing', async () => {
    const r = repo();
    r.write('p.obj', plate());
    r.commit('add');
    fs.rmSync(path.join(r.dir, 'p.obj'));
    r.commit('delete');
    r.write('p.obj', plate({ '2,2': 1 }));
    r.commit('bring back');
    const h = await modelHistory(path.join(r.dir, 'p.obj'), { ...opts, cache: false });
    expect(h.entries.map((e) => [e.status, e.step.kind])).toEqual([
      ['A', 'added'],
      ['D', 'deleted'],
      ['A', 'added'],
    ]);
    expect(h.entries[1].step.model!.faces).toBe(200);
  });

  it('a version that cannot be read is reported, and so is the next one (nothing to compare with)', async () => {
    const r = repo();
    r.write('p.obj', plate());
    r.commit('good');
    r.write('p.obj', 'v 0 0 0\nnot an obj\n');
    r.commit('broken');
    r.write('p.obj', plate({ '3,3': 0.2 }));
    r.commit('fixed');
    const h = await modelHistory(path.join(r.dir, 'p.obj'), { ...opts, cache: false });
    expect(h.entries.map((e) => e.step.kind)).toEqual(['unreadable', 'unreadable', 'added']);
    expect(h.entries[0].step.error).toMatch(/version before it could not be read/);
    expect(h.entries[0].step.model!.faces).toBe(200);
  });

  it('a .gltf is read with its .bin from the same commit', async () => {
    const r = repo();
    const gltf = (bin: Float32Array) => {
      const json = {
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, bin[8]] }],
        bufferViews: [{ buffer: 0, byteLength: 36 }],
        buffers: [{ uri: 'tri.bin', byteLength: 36 }],
      };
      return { json: JSON.stringify(json), bin: new Uint8Array(bin.buffer) };
    };
    const a = gltf(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    r.write('m/tri.gltf', a.json);
    r.write('m/tri.bin', a.bin);
    r.commit('triangle');
    const b = gltf(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0.5]));
    r.write('m/tri.gltf', b.json);
    r.write('m/tri.bin', b.bin);
    r.commit('lift a corner');
    const h = await modelHistory(path.join(r.dir, 'm/tri.gltf'), { ...opts, cache: false });
    expect(h.entries.map((e) => e.step.kind)).toEqual(['modified', 'added']);
    expect(h.entries[0].step.stats!.maxDisplacement).toBeCloseTo(0.5, 6);
  });

  it('explains a file outside git, and a file with no history', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-nogit-')));
    roots.push(dir);
    fs.writeFileSync(path.join(dir, 'p.obj'), plate());
    await expect(modelHistory(path.join(dir, 'p.obj'), opts)).rejects.toThrow(/not in a git repository/);
    const r = repo();
    r.write('a.obj', plate());
    r.commit('a');
    await expect(modelHistory(path.join(r.dir, 'missing.obj'), opts)).rejects.toThrow(/no history in git yet/);
  });
});
