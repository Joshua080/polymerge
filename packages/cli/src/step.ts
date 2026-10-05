/**
 * The optional STEP reader (decision D51): OpenCascade, from the `occt-import-js` package
 * (LGPL-2.1, ~8 MB of wasm). It is not a dependency of polymerge, so a default install stays small
 * and MIT-only; the user installs it next to polymerge, and it is loaded the first time a STEP
 * file is opened. It stays a separate, unmodified, replaceable module: POLYMERGE_OCCT can point at
 * any build with the same API.
 *
 * Where it is looked for, in order:
 *  1. $POLYMERGE_OCCT: an occt-import-js package directory;
 *  2. next to polymerge (a global install, a project's node_modules, `npx -p … -p occt-import-js`);
 *  3. the current directory's project (polymerge installed globally, occt-import-js locally).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IStepImporter } from 'polymerge-core';

export const OCCT_PACKAGE = 'occt-import-js';
/** The version polymerge is tested with. */
export const OCCT_TESTED_VERSION = '0.0.23';

export interface OcctLocation {
  /** The package directory. */
  dir: string;
  /** The emscripten loader and its wasm (dist/). */
  js: string;
  wasm: string;
  version: string;
}

function packageAt(dir: string): OcctLocation | null {
  const js = path.join(dir, 'dist', 'occt-import-js.js');
  const wasm = path.join(dir, 'dist', 'occt-import-js.wasm');
  if (!existsSync(js) || !existsSync(wasm)) return null;
  let version = 'unknown';
  try {
    version = String((JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version ?? 'unknown');
  } catch {
    // a custom build without package.json is fine
  }
  return { dir, js, wasm, version };
}

/** Where occt-import-js is installed, or null. */
export function findOcct(): OcctLocation | null {
  const fromEnv = process.env.POLYMERGE_OCCT;
  if (fromEnv) {
    const found = packageAt(path.resolve(fromEnv));
    if (!found) throw new Error(`POLYMERGE_OCCT=${fromEnv} is not an ${OCCT_PACKAGE} package directory (no dist/occt-import-js.js and .wasm)`);
    return found;
  }
  for (const from of [import.meta.url, path.join(process.cwd(), 'noop.js')]) {
    try {
      const pkg = createRequire(from).resolve(`${OCCT_PACKAGE}/package.json`);
      const found = packageAt(path.dirname(pkg));
      if (found) return found;
    } catch {
      // not installed there
    }
  }
  return null;
}

/** What to tell someone who opened a STEP file without the reader installed. */
export function occtMissingMessage(fileName?: string): string {
  return [
    `${fileName ? `${fileName}: ` : ''}STEP files are read with OpenCascade, an optional download that polymerge does not install by itself`,
    `(the ${OCCT_PACKAGE} package: LGPL-2.1, about 8 MB). Install it next to polymerge, then run the same command again:`,
    `  npm install -g ${OCCT_PACKAGE}@${OCCT_TESTED_VERSION}      if polymerge is installed globally`,
    `  npm install -D ${OCCT_PACKAGE}@${OCCT_TESTED_VERSION}      in a project that has polymerge`,
    `  npx -p @joshuahurley/polymerge -p ${OCCT_PACKAGE}@${OCCT_TESTED_VERSION} polymerge …   without installing anything`,
  ].join('\n');
}

let loading: Promise<IStepImporter> | null = null;

/** The initialised importer (loaded once per process). Throws with install instructions when it is missing. */
export function stepImporter(fileName?: string): Promise<IStepImporter> {
  if (loading) return loading;
  const found = findOcct();
  if (!found) return Promise.reject(new Error(occtMissingMessage(fileName)));
  if (found.version !== OCCT_TESTED_VERSION && found.version !== 'unknown' && !process.env.POLYMERGE_OCCT) {
    process.stderr.write(`polymerge: note: ${OCCT_PACKAGE} ${found.version} found; polymerge is tested with ${OCCT_TESTED_VERSION}\n`);
  }
  const factory = createRequire(import.meta.url)(found.js) as (module?: Record<string, unknown>) => Promise<IStepImporter>;
  loading = factory().catch((err: unknown) => {
    loading = null;
    throw new Error(`could not start ${OCCT_PACKAGE} from ${found.dir}: ${(err as Error).message ?? String(err)}`);
  });
  return loading;
}

/** Refusal for commands that would have to merge or write STEP. */
export function stepNotMergeable(fileName: string): Error {
  return new Error(
    `${fileName}: STEP files can be viewed and diffed, not merged. polymerge merges triangles, and a merged result could only ` +
      'be written as a mesh (STL, OBJ or glTF), never back as STEP. Merge the change in your CAD tool.',
  );
}
