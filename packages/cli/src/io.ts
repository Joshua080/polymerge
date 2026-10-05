import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { detectFormat, loadMesh, stepInfo, type ILoadOptions, type IMesh, type SourceFormat } from 'polymerge-core';
import { stepImporter, stepNotMergeable } from './step.js';

export interface LoadedFile {
  /** Path as given on the command line. */
  filePath: string;
  /** Name used for format detection and display. */
  fileName: string;
  bytes: Uint8Array;
  mesh: IMesh;
}

export interface LoadModelOptions extends Omit<ILoadOptions, 'step'> {
  /** STEP: the tessellation tolerance in mm (the other version's, when comparing two). */
  stepDeflection?: number;
}

/** The format of a model's bytes (by `fileName`, then content). Throws MeshLoadError when unknown. */
export function modelFormat(bytes: Uint8Array, fileName: string): SourceFormat {
  return detectFormat(bytes, fileName);
}

/** Normalise model bytes; a STEP file loads the optional OpenCascade reader first (step.ts). */
export async function loadModel(bytes: Uint8Array, fileName: string, options: LoadModelOptions = {}): Promise<IMesh> {
  const { stepDeflection, ...rest } = options;
  const format = rest.format ?? modelFormat(bytes, fileName);
  if (format !== 'step') return loadMesh(bytes, { ...rest, format, fileName });
  const importer = await stepImporter(fileName);
  return loadMesh(bytes, { ...rest, format, fileName, step: { importer, deflection: stepDeflection } });
}

/**
 * Read a model from disk and normalise it. `nameHint` overrides the name used for
 * format detection (git hands us temp files whose names may not end in the real extension).
 */
export async function loadMeshFile(filePath: string, nameHint?: string, options: LoadModelOptions = {}): Promise<LoadedFile> {
  const bytes = new Uint8Array(await readFile(filePath));
  const fileName = path.basename(nameHint ?? filePath);
  const mesh = await loadModel(bytes, fileName, options);
  return { filePath, fileName, bytes, mesh };
}

/**
 * Two versions of a model, to compare. When the first is STEP it is loaded first and the second
 * is tessellated with ITS tolerance: tessellating each with its own would give unchanged surfaces
 * different triangles, and the diff would report them as edits.
 */
export async function loadMeshPair(
  base: { path: string; name?: string },
  target: { path: string; name?: string },
): Promise<[LoadedFile, LoadedFile]> {
  const baseBytes = new Uint8Array(await readFile(base.path));
  const baseName = path.basename(base.name ?? base.path);
  if (modelFormatOrNull(baseBytes, baseName) !== 'step') {
    return Promise.all([loadMeshFile(base.path, base.name), loadMeshFile(target.path, target.name)]);
  }
  const mesh = await loadModel(baseBytes, baseName);
  const first: LoadedFile = { filePath: base.path, fileName: baseName, bytes: baseBytes, mesh };
  return [first, await loadMeshFile(target.path, target.name, { stepDeflection: stepInfo(mesh)?.deflection })];
}

function modelFormatOrNull(bytes: Uint8Array, fileName: string): SourceFormat | null {
  try {
    return modelFormat(bytes, fileName);
  } catch {
    return null; // loading reports it properly
  }
}

/** Throw the "STEP is not merged" refusal when these bytes are STEP. */
export function refuseStep(bytes: Uint8Array, fileName: string): void {
  if (modelFormatOrNull(bytes, fileName) === 'step') throw stepNotMergeable(fileName);
}
