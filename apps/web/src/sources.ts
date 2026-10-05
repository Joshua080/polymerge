/** Where meshes come from: local files, URLs (`?base=&target=`) and the fixture manifest. */
import { SOURCE_FORMATS, loadMesh, type IFixtureManifest, type IMesh, type SourceFormat } from 'polymerge-core';

export const ACCEPTED_EXTENSIONS = SOURCE_FORMATS.map((f) => `.${f}`);

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
  const m = /\.([a-z0-9]+)$/i.exec(name);
  const ext = m?.[1].toLowerCase();
  return SOURCE_FORMATS.find((f) => f === ext);
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

async function parse(bytes: ArrayBuffer, fileName: string, origin: string): Promise<ILoadedMesh> {
  const format = formatFromName(fileName);
  const mesh = await loadMesh(bytes, format ? { fileName, format } : { fileName });
  return { mesh, name: fileName, bytes: bytes.byteLength, origin };
}

export async function loadFromFile(file: File): Promise<ILoadedMesh> {
  if (!formatFromName(file.name)) {
    throw new SourceError(`"${file.name}" is not a supported model (expected ${ACCEPTED_EXTENSIONS.join(', ')}).`);
  }
  const bytes = await file.arrayBuffer();
  return parse(bytes, file.name, file.name);
}

/** Fetch + parse a model. `displayName` overrides the name derived from the URL. */
export async function loadFromUrl(url: string, displayName?: string): Promise<ILoadedMesh> {
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
  const format = formatFromName(urlName);
  const name = displayName || urlName;
  const mesh = await loadMesh(bytes, format ? { fileName: name, format } : { fileName: name });
  return { mesh, name, bytes: bytes.byteLength, origin: url };
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
