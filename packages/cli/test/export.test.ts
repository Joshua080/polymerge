/** `polymerge export`: one HTML file with the viewer and the packed diff. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMesh, fromBase64, unpackDiff, writeObj } from 'polymerge-core';
import { runExport, viewerAssets } from '../src/commands/export.js';
import { CUBE_CORNERS, CUBE_TRIS } from '../../core/test/parsers/helpers.js';

let dir = '';
const file = (name: string) => path.join(dir, name);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'polymerge-export-'));
  // A stand-in for the built viewer (the tests run before `npm run build`).
  mkdirSync(file('viewer/assets'), { recursive: true });
  writeFileSync(
    file('viewer/index.html'),
    '<!doctype html><html><head><script type="module" crossorigin src="./assets/index-abc.js"></script><link rel="stylesheet" crossorigin href="./assets/index-abc.css"></head><body><div id="app"></div></body></html>',
  );
  writeFileSync(file('viewer/assets/index-abc.js'), 'console.log("viewer </script> here");');
  writeFileSync(
    file('viewer/assets/index-abc.css'),
    "@font-face{font-family:'Inter Variable';src:url(./inter-latin-wght-normal-X.woff2) format('woff2-variations')}@font-face{font-family:'Inter Variable';src:url(./inter-latin-ext-wght-normal-Y.woff2)}body{margin:0}",
  );
  writeFileSync(file('viewer/assets/inter-latin-wght-normal-X.woff2'), Uint8Array.from([119, 79, 70, 50]));
  writeFileSync(file('a.obj'), writeObj(createMesh(CUBE_CORNERS.flat(), CUBE_TRIS.flat())));
  writeFileSync(file('b.obj'), writeObj(createMesh(CUBE_CORNERS.flat().map((v, i) => (i === 20 ? v + 0.5 : v)), CUBE_TRIS.flat())));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('export', () => {
  it('reads the viewer: its script, and its style with the Latin font inlined', async () => {
    const { script, style } = await viewerAssets(file('viewer'));
    expect(script).toContain('viewer </script> here');
    expect(style).toContain('url(data:font/woff2;base64,d09GMg==)');
    expect(style).not.toContain('latin-ext');
  });

  it('writes one page carrying both models and the result', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await runExport(file('a.obj'), file('b.obj'), { output: file('page.html'), webDist: file('viewer'), up: 'z', version: '9.9.9' })).toBe(0);
      expect(String(out.mock.calls[0][0])).toMatch(/^Wrote .*page\.html \(\d+ KB\): a\.obj → b\.obj, Tier 1, vertices 1 moved\./);
    } finally {
      vi.restoreAllMocks();
    }
    const html = readFileSync(file('page.html'), 'utf8');
    expect(html).toContain('<title>a.obj → b.obj · polymerge</title>');
    expect(html).toContain('<meta name="generator" content="polymerge 9.9.9" />');
    expect(html).toContain('<script type="module">console.log("viewer <\\/script> here");</script>');
    expect(html).not.toMatch(/src="\.\/assets|href="\.\/assets/);
    const payload = /id="polymerge-embed"[^>]*>([^<]*)<\/script>/.exec(html)![1];
    const d = unpackDiff(fromBase64(payload));
    expect([d.base.name, d.target.name, d.generator, d.view?.up]).toEqual(['a.obj', 'b.obj', 'polymerge 9.9.9', 'z']);
    expect(d.result.stats.vertices.moved).toBe(1);
    expect(d.target.mesh.faceCount).toBe(12);
  });

  it('refuses a bad --up before doing any work', async () => {
    await expect(runExport(file('a.obj'), file('b.obj'), { webDist: file('viewer'), up: 'x', version: '1' })).rejects.toThrow(/--up must be y or z/);
  });
});
