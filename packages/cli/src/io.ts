import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadMesh, type ILoadOptions, type IMesh } from 'polymerge-core';

export interface LoadedFile {
  /** Path as given on the command line. */
  filePath: string;
  /** Name used for format detection and display. */
  fileName: string;
  bytes: Uint8Array;
  mesh: IMesh;
}

/**
 * Read a model from disk and normalise it. `nameHint` overrides the name used for
 * format detection (git hands us temp files whose names may not end in the real extension).
 */
export async function loadMeshFile(filePath: string, nameHint?: string, options: ILoadOptions = {}): Promise<LoadedFile> {
  const bytes = new Uint8Array(await readFile(filePath));
  const fileName = path.basename(nameHint ?? filePath);
  const mesh = await loadMesh(bytes, { ...options, fileName });
  return { filePath, fileName, bytes, mesh };
}
