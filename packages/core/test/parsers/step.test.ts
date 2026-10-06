/**
 * STEP loading through an injected importer (src/parsers/step.ts). These tests use a FAKE
 * importer that returns occt-import-js-shaped results, so they need no wasm; the CLI's tests run
 * the real OpenCascade importer on real STEP files.
 */
import { describe, expect, it } from 'vitest';
import { detectFormat, formatFromFileName, loadMesh, sniffFormat, stepDeflectionFor, stepInfo } from '../../src/parsers/index.js';
import { MeshLoadError, type IStepImporter, type IStepImportMesh, type IStepImportParams, type IStepImportResult } from '../../src/types.js';
import { CUBE_CORNERS, CUBE_TRIS, utf8 } from './helpers.js';

const STEP_TEXT = 'ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((\'\'),\'2;1\');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n';

/** A unit cube as one solid, its 6 sides as 6 B-rep faces of 2 triangles each, every face with its own vertices. */
function cubeSolid(opts: { name?: string; color?: number[] | null; faceColors?: (number[] | null)[]; offset?: number; scale?: number } = {}): IStepImportMesh {
  const s = opts.scale ?? 1;
  const o = opts.offset ?? 0;
  const position: number[] = [];
  const index: number[] = [];
  const brep_faces: { first: number; last: number; color: number[] | null }[] = [];
  for (let f = 0; f < 6; f++) {
    const tris = CUBE_TRIS.slice(f * 2, f * 2 + 2);
    const local = new Map<number, number>();
    for (const tri of tris) {
      for (const c of tri) {
        if (!local.has(c)) {
          local.set(c, position.length / 3);
          const [x, y, z] = CUBE_CORNERS[c];
          position.push(x * s + o, y * s, z * s);
        }
        index.push(local.get(c)!);
      }
    }
    brep_faces.push({ first: f * 2, last: f * 2 + 1, color: opts.faceColors?.[f] ?? null });
  }
  return { name: opts.name ?? '', color: opts.color ?? null, brep_faces, attributes: { position: { array: position } }, index: { array: index } };
}

/** An importer that records its calls and returns `result` (or a function of the params). */
function fakeImporter(result: IStepImportResult | ((params: IStepImportParams) => IStepImportResult)): IStepImporter & { calls: IStepImportParams[] } {
  const calls: IStepImportParams[] = [];
  return {
    calls,
    ReadStepFile(_content, params) {
      calls.push(params ?? {});
      return typeof result === 'function' ? result(params ?? {}) : result;
    },
  };
}

const load = (importer: IStepImporter, extra: { deflection?: number; angularDeflection?: number } = {}, fileName = 'part.step') =>
  loadMesh(utf8(STEP_TEXT), { fileName, step: { importer, ...extra } });

describe('STEP detection', () => {
  it.each([
    ['part.step', 'step'],
    ['PART.STP', 'step'],
    ['https://example.com/cad/bracket.stp?raw=1', 'step'],
  ] as const)('%s → %s', (name, format) => {
    expect(formatFromFileName(name)).toBe(format);
  });

  it('sniffs the Part 21 keyword (after a BOM / blank lines)', () => {
    expect(sniffFormat(utf8(STEP_TEXT))).toBe('step');
    expect(sniffFormat(utf8(`﻿\n  ${STEP_TEXT}`))).toBe('step');
    expect(detectFormat(utf8(STEP_TEXT), 'noext')).toBe('step');
    expect(sniffFormat(utf8('ISO-10303-28 something else'))).toBeUndefined();
  });

  it('names STEP in the unknown-format message', () => {
    expect(() => detectFormat(utf8('hello'))).toThrow(/GLB or STEP/);
  });
});

describe('STEP loading', () => {
  it('needs an importer, and says where to get one', async () => {
    const err = await loadMesh(utf8(STEP_TEXT), { fileName: 'part.step' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeshLoadError);
    expect((err as MeshLoadError).format).toBe('step');
    expect((err as Error).message).toMatch(/^part\.step: .*occt-import-js.*LGPL/);
  });

  it('turns each solid into a named group, welded, with STEP metadata', async () => {
    const importer = fakeImporter({ success: true, meshes: [cubeSolid({ name: 'block' })] });
    const mesh = await load(importer, { deflection: 0.1 });
    expect(mesh.metadata.format).toBe('step');
    // 6 faces × 4 corners in the source; welded on the shared edges into the cube's 8 corners.
    expect(mesh.metadata.sourceVertexCount).toBe(24);
    expect(mesh.vertexCount).toBe(8);
    expect(mesh.faceCount).toBe(12);
    expect(mesh.groups).toEqual([{ name: 'block', faceStart: 0, faceCount: 12 }]);
    expect(stepInfo(mesh)).toEqual({ deflection: 0.1, angularDeflection: 0.5, unit: 'mm', solids: 1, brepFaces: 6 });
  });

  it('tessellates once, in millimetres with an ABSOLUTE deflection, when one is given', async () => {
    const importer = fakeImporter({ success: true, meshes: [cubeSolid()] });
    await load(importer, { deflection: 0.02, angularDeflection: 0.3 });
    expect(importer.calls).toEqual([{ linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.02, angularDeflection: 0.3 }]);
  });

  it('without one, measures the model with a coarse pass and derives a round value from its size', async () => {
    // A 100 mm cube: diagonal 173.2 mm → 1/2000 of it = 0.0866 → rounded down to 0.05.
    const importer = fakeImporter({ success: true, meshes: [cubeSolid({ scale: 100 })] });
    const mesh = await load(importer);
    expect(importer.calls.map((c) => c.linearDeflectionType)).toEqual(['bounding_box_ratio', 'absolute_value']);
    expect(importer.calls[1].linearDeflection).toBe(0.05);
    expect(importer.calls.every((c) => c.linearUnit === 'millimeter')).toBe(true);
    expect(stepInfo(mesh)?.deflection).toBe(0.05);
  });

  it('rounds the derived deflection down to 1, 2 or 5 × 10ⁿ', () => {
    const box = (d: number) => ({ min: [0, 0, 0] as [number, number, number], max: [d, 0, 0] as [number, number, number] });
    expect(stepDeflectionFor(box(117))).toBe(0.05); // 0.0585
    expect(stepDeflectionFor(box(1000))).toBe(0.5);
    expect(stepDeflectionFor(box(3000))).toBe(1); // 1.5
    expect(stepDeflectionFor(box(9000))).toBe(2); // 4.5
    expect(stepDeflectionFor(box(10_000))).toBe(5);
    expect(stepDeflectionFor(box(1))).toBe(0.0005);
    expect(stepDeflectionFor(box(0))).toBe(0.01);
  });

  it('keeps colours as materials (sRGB hex names, linear values), per B-rep face when a face has its own', async () => {
    const red = [1, 0, 0];
    const half = [0.2158605, 0.2158605, 0.2158605]; // linear for sRGB #808080
    const importer = fakeImporter({ success: true, meshes: [cubeSolid({ name: 'a', color: half, faceColors: [null, red, null, null, null, null] })] });
    const mesh = await load(importer, { deflection: 0.1 });
    expect(mesh.materials.map((m) => m.name)).toEqual(['#808080', '#ff0000']);
    expect(mesh.materials[0].color?.[0]).toBeCloseTo(0.2159, 4);
    // Face order: B-rep face 0 (triangles 0-1) has the solid's colour, face 1 (2-3) its own.
    expect(Array.from(mesh.faceMaterials!.slice(0, 4))).toEqual([0, 0, 1, 1]);
    expect(mesh.groups[0].materialIndex).toBeUndefined(); // mixed
  });

  it('a solid with one colour gets it as its group material; uncoloured solids get none', async () => {
    const importer = fakeImporter({ success: true, meshes: [cubeSolid({ name: 'blue', color: [0, 0, 1] }), cubeSolid({ name: 'plain', offset: 5 })] });
    const mesh = await load(importer, { deflection: 0.1 });
    expect(mesh.groups.map((g) => [g.name, g.materialIndex])).toEqual([
      ['blue', 0],
      ['plain', undefined],
    ]);
  });

  it('names: the solid, else its assembly node, else the file; repeats get #2, #3', async () => {
    const importer = fakeImporter({
      success: true,
      root: { name: '', meshes: [], children: [{ name: 'bolt', meshes: [1, 2] }, { name: '', meshes: [3] }] },
      meshes: [cubeSolid({ name: 'frame' }), cubeSolid({ offset: 2 }), cubeSolid({ offset: 4 }), cubeSolid({ offset: 6 })],
    });
    const mesh = await load(importer, { deflection: 0.1 }, 'dir/bracket.stp');
    expect(mesh.groups.map((g) => g.name)).toEqual(['frame', 'bolt', 'bolt #2', 'bracket']);
  });

  it('reports a file OpenCascade cannot read, and one with no surfaces', async () => {
    await expect(load(fakeImporter({ success: false }), { deflection: 0.1 })).rejects.toThrow(/part\.step: OpenCascade could not read this file as STEP/);
    await expect(load(fakeImporter({ success: true, meshes: [] }), { deflection: 0.1 })).rejects.toThrow(/contains no surfaces/);
    await expect(load(fakeImporter({ success: true, meshes: [] }))).rejects.toThrow(/contains no surfaces/);
  });

  it('wraps an importer crash in a MeshLoadError', async () => {
    const importer: IStepImporter = {
      ReadStepFile() {
        throw new Error('RuntimeError: memory access out of bounds');
      },
    };
    const err = await load(importer, { deflection: 0.1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeshLoadError);
    expect((err as Error).message).toMatch(/failed to parse STEP data: RuntimeError/);
  });

  it('rejects a bad deflection', async () => {
    const importer = fakeImporter({ success: true, meshes: [cubeSolid()] });
    await expect(load(importer, { deflection: 0 })).rejects.toThrow(/step\.deflection must be a finite number > 0/);
    await expect(load(importer, { angularDeflection: Number.NaN })).rejects.toThrow(/step\.angularDeflection/);
  });

  it('stepInfo is undefined for other formats', async () => {
    const importer = fakeImporter({ success: true, meshes: [cubeSolid()] });
    const mesh = await load(importer, { deflection: 0.1 });
    expect(stepInfo({ ...mesh, metadata: { ...mesh.metadata, format: 'stl' } })).toBeUndefined();
  });
});
