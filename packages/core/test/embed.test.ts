import { describe, expect, it } from 'vitest';
import { diffMeshes, serializeDiff } from '../src/diff/index.js';
import { fromBase64, inlineFonts, inlineScript, packDiff, standaloneHtml, toBase64, unpackDiff } from '../src/embed.js';
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
