import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, checkImages, readResult, validateResult } from '../lib/validate.mjs';

const SHA = 'ab'.repeat(20);
const summary = {
  tier: 2,
  vertices: { before: 1, after: 1, unchanged: 0, moved: 1, added: 0, removed: 0 },
  faces: { before: 1, after: 1, unchanged: 0, modified: 1, added: 0, removed: 0 },
  maxDisplacement: 0.5,
  parts: [],
  partsTotal: 0,
  transform: { units: { from: 'in', to: 'mm', factor: 25.4 }, scale: 25.4, rotationDeg: 0, distance: 1 },
  geometry: { unit: 'mm', size: { before: [1, 2, 3], after: [1, 2, 4] }, area: { before: 22, after: 28 }, volume: { before: 6, after: 8 }, closed: { before: true, after: true } },
  cad: { faces: 6, unchanged: 5, changes: [{ kind: 'moved', text: 'flat face facing +Z moved 1 mm (0, 0, +1)' }], changesTotal: 1 },
};
function good(): any {
  return structuredClone({
    schema: 1,
    tool: 'polymerge 0.1.1',
    pr: 12,
    base: SHA,
    head: 'cd'.repeat(20),
    limits: { maxFiles: 10, maxFaces: 200000, maxBytes: 52428800 },
    files: [
      { path: 'a.stl', oldPath: null, change: 'modified', status: 'rendered', image: '0.png', error: null, modeChanged: false, mesh: { before: { vertices: 1, faces: 1 }, after: { vertices: 1, faces: 1 } }, limit: null, diff: summary },
      { path: 'b.obj', oldPath: null, change: 'added', status: 'error', image: null, error: 'bad', modeChanged: false, mesh: { before: null, after: null }, limit: null, diff: null },
    ],
  });
}

/** A minimal valid PNG of the given size (one grey scanline per row). */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(Math.min(height, 4) * (width * 3 + 1), 128);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const dirs: string[] = [];
function dir(files: Record<string, Buffer | string>) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-validate-'));
  dirs.push(d);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(d, name), content);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('validateResult', () => {
  it('accepts a render result and copies only known fields', () => {
    const raw = good();
    raw.evil = '<script>';
    raw.files[0].html = '<img onerror>';
    raw.files[0].diff.tierName = 'ignored';
    const v = validateResult(raw);
    expect(v.files[0]).toEqual({ ...good().files[0] });
    expect('evil' in v).toBe(false);
    expect('html' in v.files[0]).toBe(false);
    expect('tierName' in v.files[0].diff!).toBe(false);
  });

  it('defaults the view settings of an older result, and keeps valid ones', () => {
    expect(validateResult(good())).toMatchObject({ palette: 'standard', upAxis: 'auto' });
    expect(validateResult({ ...good(), palette: 'colorblind', upAxis: 'z' })).toMatchObject({ palette: 'colorblind', upAxis: 'z' });
  });

  const broken: [string, (r: any) => void][] = [
    ['another schema', (r) => (r.schema = 2)],
    ['a short commit id', (r) => (r.head = 'abc1234')],
    ['a PR number that is not a whole number', (r) => (r.pr = '12; rm -rf /')],
    ['an image name with a path', (r) => (r.files[0].image = '../../etc/passwd')],
    ['an image on a row that was not rendered', (r) => (r.files[1].image = '1.png')],
    ['a rendered row without an image', (r) => (r.files[0].image = null)],
    ['one image on two rows', (r) => Object.assign(r.files[1], { status: 'rendered', image: '0.png' })],
    ['an unknown status', (r) => (r.files[0].status = 'owned')],
    ['an unknown change', (r) => (r.files[0].change = 'copied')],
    ['an over-long path', (r) => (r.files[0].path = 'x'.repeat(LIMITS.path + 1))],
    ['a NUL in a path', (r) => (r.files[0].path = 'a\0b.stl')],
    ['a count that is not a number', (r) => (r.files[0].diff.vertices.moved = 'many')],
    ['a negative count', (r) => (r.files[0].mesh.after.faces = -1)],
    ['an infinite displacement', (r) => (r.files[0].diff.maxDisplacement = Infinity)],
    ['a tier that does not exist', (r) => (r.files[0].diff.tier = 4)],
    ['an unknown unit', (r) => (r.files[0].diff.transform.units.to = 'parsec')],
    ['too many parts', (r) => (r.files[0].diff.parts = Array.from({ length: 21 }, () => ({ name: null, rotationDeg: 0, distance: 0 })))],
    ['too many files', (r) => (r.files = Array.from({ length: LIMITS.files + 1 }, () => good().files[1]))],
    ['an unknown palette', (r) => (r.palette = 'rainbow')],
    ['an unknown up axis', (r) => (r.upAxis = 'x')],
  ];
  for (const [what, edit] of broken) {
    it(`rejects ${what}`, () => {
      const r = good();
      edit(r);
      expect(() => validateResult(r)).toThrow(/invalid render result/);
    });
  }
});

describe('readResult / checkImages', () => {
  it('accepts real PNGs with our names', () => {
    const d = dir({ 'result.json': JSON.stringify(good()), '0.png': png(1600, 678) });
    const result = readResult(d);
    const images = checkImages(d, result);
    expect(images.map((i: { name: string }) => i.name)).toEqual(['0.png']);
  });

  it('rejects an image that is not a PNG, is missing, is a link, or is absurdly large', () => {
    const r = readResult(dir({ 'result.json': JSON.stringify(good()) }));
    expect(() => checkImages(dir({ '0.png': '<svg onload=alert(1)>' }), r)).toThrow(/not a PNG/);
    expect(() => checkImages(dir({}), r)).toThrow(/missing/);
    const linked = dir({ 'target.png': png(10, 10) });
    fs.symlinkSync(path.join(linked, 'target.png'), path.join(linked, '0.png'));
    expect(() => checkImages(linked, r)).toThrow(/not a regular file/);
    expect(() => checkImages(dir({ '0.png': png(100_000, 10) }), r)).toThrow(/unreasonable size/);
  });

  it('rejects a result.json that is not JSON, or not a file', () => {
    expect(() => readResult(dir({ 'result.json': '{"schema": 1,' }))).toThrow(/not JSON/);
    const d = dir({});
    fs.mkdirSync(path.join(d, 'result.json'));
    expect(() => readResult(d)).toThrow(/regular file/);
  });
});
