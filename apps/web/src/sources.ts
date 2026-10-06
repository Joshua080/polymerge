/** Where meshes come from: local files, URLs (`?base=&target=`) and the fixture manifest. */
import { detectFormat, formatFromFileName, loadMesh, stepInfo, type IFixtureManifest, type IMesh, type SourceFormat } from 'polymerge-core';
import { stepImporter } from './step.js';

export const ACCEPTED_EXTENSIONS = ['.stl', '.obj', '.gltf', '.glb', '.step', '.stp'];

/** How to read one model. */
export interface ILoadOptions {
  /**
   * STEP: the tessellation tolerance to use, usually the other version's (two versions must share
   * it, or unchanged surfaces get different triangles). Only awaited when the model IS STEP.
   */
  stepDeflection?: () => Promise<number | undefined>;
  /** Refuse STEP before downloading anything (the merge review: STEP is view / diff only). */
  refuseStep?: boolean;
}

/** One side's loader: the options let a pair share what one side learnt. */
export type Loader = (options?: ILoadOptions) => Promise<ILoadedMesh>;

/**
 * Start loading two versions in parallel. A STEP target waits for the base and is tessellated
 * with the base's tolerance (any other target does not wait).
 */
export function pairLoads(base: Loader | null, target: Loader | null): [Promise<ILoadedMesh | null>, Promise<ILoadedMesh | null>] {
  let settle: (deflection: number | undefined) => void = () => {};
  const deflection = new Promise<number | undefined>((resolve) => (settle = resolve));
  const b = base
    ? base().then(
        (m) => (settle(stepInfo(m.mesh)?.deflection), m),
        (err: unknown) => {
          settle(undefined);
          throw err;
        },
      )
    : (settle(undefined), Promise.resolve(null));
  const t = target ? target({ stepDeflection: () => deflection }) : Promise.resolve(null);
  return [b, t];
}

export interface ILoadedMesh {
  mesh: IMesh;
  /** Display name (file name). */
  name: string;
  /** Size of the source bytes. */
  bytes: number;
  /** Where it came from: file name, URL, ... */
  origin: string;
}

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

export function formatFromName(name: string): SourceFormat | undefined {
  return formatFromFileName(name);
}

/** Last path segment of a URL (decoded), without query / hash. */
export function fileNameFromUrl(url: string): string {
  let pathname = url;
  try {
    pathname = new URL(url, document.baseURI).pathname;
  } catch {
    pathname = url.split(/[?#]/)[0];
  }
  const last = pathname.split('/').filter(Boolean).pop() ?? pathname;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Normalise model bytes. `formatName` decides the format (by extension, else by content);
 * `fileName` is what the mesh is called. STEP goes through the optional OpenCascade reader.
 */
async function parse(bytes: ArrayBuffer, formatName: string, fileName: string, origin: string, options: ILoadOptions): Promise<ILoadedMesh> {
  let format = formatFromName(formatName);
  if (!format) {
    try {
      format = detectFormat(bytes, formatName);
    } catch {
      // loadMesh reports the unknown format
    }
  }
  let mesh: IMesh;
  if (format === 'step') {
    if (options.refuseStep) {
      throw new SourceError(
        `“${fileName}” is a STEP file. STEP files can be viewed and diffed, not merged: a merged result could only be a mesh, never STEP again. Merge the change in your CAD tool.`,
      );
    }
    const importer = await stepImporter(fileName);
    const deflection = await options.stepDeflection?.();
    mesh = await loadMesh(bytes, { fileName, format, step: { importer, deflection } });
  } else {
    mesh = await loadMesh(bytes, format ? { fileName, format } : { fileName });
  }
  return { mesh, name: fileName, bytes: bytes.byteLength, origin };
}

export async function loadFromFile(file: File, options: ILoadOptions = {}): Promise<ILoadedMesh> {
  if (!formatFromName(file.name)) {
    throw new SourceError(`"${file.name}" is not a supported model (expected ${ACCEPTED_EXTENSIONS.join(', ')}).`);
  }
  const bytes = await file.arrayBuffer();
  return parse(bytes, file.name, file.name, file.name, options);
}

/** Fetch + parse a model. `displayName` overrides the name derived from the URL. */
export async function loadFromUrl(url: string, displayName?: string, options: ILoadOptions = {}): Promise<ILoadedMesh> {
  const resolved = new URL(url, document.baseURI).href;
  let res: Response;
  try {
    res = await fetch(resolved);
  } catch (err) {
    // A blocked cross-origin request and a wrong address both surface as a bare TypeError.
    const foreign = new URL(resolved).origin !== location.origin;
    const hint = foreign ? ' The address may be wrong, or that server does not allow other sites to read its files (CORS), or it is http while this page is https.' : '';
    throw new SourceError(`Network error fetching ${url}: ${(err as Error).message}.${hint}`);
  }
  if (!res.ok) throw new SourceError(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
  // SPA-style servers (incl. `vite preview`) answer unknown paths with index.html + 200.
  if ((res.headers.get('content-type') ?? '').includes('text/html')) {
    throw new SourceError(`${url} returned an HTML page instead of a model (wrong path?)`);
  }
  const bytes = await res.arrayBuffer();
  const urlName = fileNameFromUrl(url);
  // Format always follows the URL's extension (e.g. /models/base.glb); the display name is cosmetic.
  return parse(bytes, urlName, displayName || urlName, url, options);
}

/** Candidate manifest URLs: relative to the page (works under any base path), then site root. */
function manifestUrls(): string[] {
  const rel = new URL('fixtures/manifest.json', document.baseURI).href;
  const abs = new URL('/fixtures/manifest.json', document.baseURI).href;
  return rel === abs ? [rel] : [rel, abs];
}

export interface IManifestInfo {
  manifest: IFixtureManifest;
  /** URL the manifest was fetched from; case paths resolve against its directory. */
  url: string;
}

/** Load fixtures/manifest.json; resolves null (not an error) if there is none. */
export async function loadManifest(): Promise<IManifestInfo | null> {
  for (const url of manifestUrls()) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) continue;
      const text = await res.text();
      const manifest = JSON.parse(text) as IFixtureManifest;
      if (!manifest || !Array.isArray(manifest.cases)) continue;
      return { manifest, url };
    } catch {
      // not JSON (e.g. an SPA fallback page) or unreachable: try the next candidate
    }
  }
  return null;
}

/** Resolve a manifest-relative path (e.g. "cases/x/base.stl") to an absolute URL. */
export function fixtureUrl(info: IManifestInfo, relPath: string): string {
  return new URL(relPath, info.url).href;
}
