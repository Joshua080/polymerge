import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffMeshes, serializeDiff } from '../src/diff/index.js';
import { fromBase64, inlineFonts, inlineScript, packDiff, packPage, standaloneHtml, toBase64, unpackDiff, unpackPage } from '../src/embed.js';
import { createMesh } from '../src/mesh.js';
import { CUBE_CORNERS, CUBE_TRIS } from './parsers/helpers.js';

const silent = { info: () => {}, warn: () => {} };

describe('base64', () => {
  it('matches Node for every length and byte value', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255, 256, 3 * 16384 + 1, 100_000]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 7919 + n) & 255);
      const text = toBase64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64'));
      expect(Array.from(fromBase64(text))).toEqual(Array.from(bytes));
    }
  });
});

describe('packDiff / unpackDiff', () => {
  it('round-trips both models and the result exactly', () => {
    const base = createMesh(CUBE_CORNERS.flat(), CUBE_TRIS.flat(), { metadata: { format: 'obj', sourceName: 'cube.obj' } });
    const moved = CUBE_CORNERS.flat().map((v, i) => (i === 2 * 3 + 2 ? v + 0.1 : v));
    const target = createMesh(moved, CUBE_TRIS.flat(), { metadata: { format: 'stl', sourceName: 'cube-v2.stl' } });
    target.faceMaterials = new Int32Array(target.faceCount).fill(-1);
    target.brep = { faceOf: Int32Array.from({ length: target.faceCount }, (_, i) => i >> 1), faces: [] };
    const result = diffMeshes(base, target, { logger: silent });
    const packed = packDiff({ generator: 'polymerge test', base: { name: 'cube.obj', bytes: 123, mesh: base }, target: { name: 'cube-v2.stl', bytes: 456, mesh: target }, result, view: { up: 'z' } });
    const back = unpackDiff(packed);
    expect(back.generator).toBe('polymerge test');
    expect(back.view).toEqual({ up: 'z' });
    expect([back.base.name, back.base.bytes, back.target.name, back.target.bytes]).toEqual(['cube.obj', 123, 'cube-v2.stl', 456]);
    for (const [a, b] of [
      [back.base.mesh, base],
      [back.target.mesh, target],
    ] as const) {
      expect(a.positions).toBeInstanceOf(Float64Array);
      expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
      expect(Array.from(a.faces)).toEqual(Array.from(b.faces));
      expect(a.groups).toEqual(b.groups);
      expect(a.metadata).toEqual(b.metadata);
      expect([a.vertexCount, a.faceCount]).toEqual([b.vertexCount, b.faceCount]);
    }
    expect(Array.from(back.target.mesh.faceMaterials!)).toEqual(Array.from(target.faceMaterials));
    expect(Array.from(back.target.mesh.brep!.faceOf)).toEqual(Array.from(target.brep.faceOf));
    expect(serializeDiff(back.result)).toBe(serializeDiff(result));
  });

  it('still opens a page saved by 0.3 (payload version 1)', () => {
    const v1 = readFileSync(path.join(__dirname, 'fixtures/page-v1-step-plate.b64'), 'utf8');
    const d = unpackDiff(fromBase64(v1));
    expect([d.base.name, d.target.name]).toEqual(['base.step', 'ours.step']);
    expect(d.result.brep?.changes[0].description).toBe('hole Ø8 moved 5 mm (+5, 0, 0)');
    expect(unpackPage(fromBase64(v1)).history).toBeUndefined();
  });

  it('a page with a history: several models, results between them, the versions', () => {
    const cube = (z: number) => createMesh(CUBE_CORNERS.flat().map((v, i) => (i === 20 ? v + z : v)), CUBE_TRIS.flat());
    const [a, b, c] = [cube(0), cube(0.2), cube(0.5)];
    const r1 = diffMeshes(a, b, { logger: silent });
    const r2 = diffMeshes(b, c, { logger: silent });
    const version = (short: string, model: number | null) => ({ commit: short.repeat(5), short, author: 'J', date: '2026-10-13T10:00:00Z', subject: `v ${short}`, status: model === null ? 'D' : 'M', path: 'm.obj', summary: ['~ changed'], model });
    const page = unpackPage(
      packPage({
        generator: 'polymerge test',
        models: [a, b, c].map((mesh, i) => ({ name: `v${i}.obj`, bytes: 0, mesh })),
        results: [
          { base: 0, target: 1, result: r1 },
          { base: 1, target: 2, result: r2 },
        ],
        history: { file: 'm.obj', versions: [version('ccc', null), version('bbb', 2), version('aaa', 1)] },
      }),
    );
    expect(page.models).toHaveLength(3);
    expect(page.results.map((r) => [r.base, r.target, r.result.stats.vertices.moved])).toEqual([
      [0, 1, 1],
      [1, 2, 1],
    ]);
    expect(page.history?.versions.map((v) => [v.short, v.model])).toEqual([
      ['ccc', null],
      ['bbb', 2],
      ['aaa', 1],
    ]);
    // A history page has no single diff to hand to an old reader.
    expect(() => unpackDiff(packPage({ generator: 'x', models: [], results: [] }))).toThrow(/no diff/);
  });

  it('refuses what is not a payload', () => {
    expect(() => unpackDiff(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe('the page', () => {
  it('keeps "</script>" in the viewer code from ending its script', () => {
    const html = standaloneHtml({ title: 'a <b> & c', script: 'const s = "</script><!-- x";', style: 'body{}', payload: 'QUJD', generator: 'polymerge test' });
    expect(html.match(/<\/script>/g)).toHaveLength(2); // the payload's and the module's own end tags
    expect(html).toContain('const s = "<\\/script><\\!-- x";');
    expect(html).toContain('<title>a &lt;b&gt; &amp; c</title>');
    expect(html).toContain('id="polymerge-embed" data-encoding="pmx1+deflate+base64">QUJD</script>');
    expect(inlineScript('a</SCRIPT b')).toBe('a<\\/SCRIPT b');
  });

  it('inlines the fonts it is given and drops the others', () => {
    const css = `@font-face{font-family:X;src:url(./a.woff2) format('woff2')}@font-face{font-family:X;src:url("./b.woff2")}body{color:red}`;
    const out = inlineFonts(css, { './a.woff2': new Uint8Array([1, 2, 3]) });
    expect(out).toContain('url(data:font/woff2;base64,AQID)');
    expect(out).not.toContain('b.woff2');
    expect(out).toContain('body{color:red}');
  });
});
