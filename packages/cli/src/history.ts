/**
 * A model's history in git: its versions (newest first), following renames, with deletions and
 * uncommitted changes, and what changed from each version to the next. `polymerge log` prints it;
 * `log --view` and `log -o page.html` show it in the viewer.
 *
 * Versions come from `git log --follow`, so they are the commits that changed the file along the
 * history git shows for it (merges that only brought it in unchanged are left out). Each change is
 * computed between consecutive versions, so one entry reads as "what this commit did to the
 * model". Results are cached in the repository's git directory, keyed by the two blobs, so a
 * second `log` is instant.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  changeRegions,
  compareMetrics,
  computeMetrics,
  diffMeshes,
  stepInfo,
  type IChangeRegion,
  type IDiffResult,
  type IMesh,
  type IMetricsComparison,
  type IMeshMetrics,
  type MatchTier,
} from 'polymerge-core';
import { inlineGltfResources } from './gltf-resources.js';
import { loadModel, readModelFile } from './io.js';
import { silentLogger } from './report.js';

const run = promisify(execFile);

/** One version of the file. */
export interface IFileVersion {
  /** Full commit id; "" for the uncommitted working-tree version. */
  commit: string;
  short: string;
  author: string;
  /** ISO 8601 author date (for the working tree: the file's modification time). */
  date: string;
  subject: string;
  /** Repository-relative path in this version. */
  path: string;
  /** git's status for the file in this commit: A added, M modified, R renamed, D deleted (C copied, T type). */
  status: 'A' | 'M' | 'R' | 'D' | 'C' | 'T' | 'W';
  /** The renamed-from path (status R). */
  from?: string;
  /** The blob id of the content; null when the commit deleted it. */
  blob: string | null;
}

/** What one version did to the model, compared with the version before it. */
export interface IHistoryStep {
  kind: 'added' | 'modified' | 'unchanged' | 'deleted' | 'unreadable';
  /** Set when the version could be compared with the one before it. */
  tier?: MatchTier;
  stats?: IDiffResult['stats'];
  metrics?: IMetricsComparison;
  /** The model on its own (added; also the version a deletion removed). */
  model?: IMeshMetrics & { faces: number; vertices: number };
  /** Face-aware STEP: what changed, in CAD terms. */
  cad?: string[];
  /** The largest regions of change. */
  regions?: Pick<IChangeRegion, 'side' | 'faces' | 'center' | 'size' | 'maxDisplacement'>[];
  /** Why it could not be read or compared. */
  error?: string;
}

export interface IHistoryEntry extends IFileVersion {
  step: IHistoryStep;
}

/** git, in `cwd`; stdout as text (or bytes with `buffer`). */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 1 << 30, encoding: 'utf8' });
  return stdout;
}

async function gitBytes(cwd: string, args: string[]): Promise<Uint8Array> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 1 << 30, encoding: 'buffer' });
  return new Uint8Array(stdout);
}

/** The repository holding `file`: its top directory and the file's path inside it. */
export async function locate(file: string): Promise<{ top: string; rel: string }> {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  let top: string;
  try {
    top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new Error(`${file} is not in a git repository: "log" reads the file's history from git`);
  }
  // Resolve symlinks on both sides (macOS /var → /private/var) before taking the relative path.
  const { realpathSync } = await import('node:fs');
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const rel = path.relative(real(top), path.join(real(dir), path.basename(abs))).split(path.sep).join('/');
  return { top, rel };
}

const RS = '\x1e';
const US = '\x1f';

/** The versions of `rel` in the repository at `top`, newest first (at most `max` commits). */
export async function fileVersions(top: string, rel: string, max: number): Promise<IFileVersion[]> {
  const out = await git(top, ['log', '--follow', '-M', `--max-count=${max}`, `--format=${RS}%H${US}%h${US}%an${US}%aI${US}%s`, '--name-status', '--', rel]);
  const versions: IFileVersion[] = [];
  let current = rel;
  for (const record of out.split(RS).slice(1)) {
    const [head, ...rest] = record.split('\n');
    const [commit, short, author, date, subject] = head.split(US);
    // The name-status line for our file (a rename lists old and new path).
    const line = rest.map((l) => l.split('\t')).find((cols) => cols.length >= 2);
    let status: IFileVersion['status'] = 'M';
    let p = current;
    let from: string | undefined;
    if (line) {
      const code = line[0][0] as IFileVersion['status'];
      status = 'AMRDCT'.includes(code) ? code : 'M';
      if (code === 'R' || code === 'C') {
        from = line[1];
        p = line[2];
      } else p = line[1];
    }
    versions.push({ commit, short, author, date, subject, path: p, status, from, blob: null });
    // Older commits know the file by its old name.
    current = from ?? p;
  }
  for (const v of versions) {
    if (v.status === 'D') continue;
    try {
      v.blob = (await git(top, ['rev-parse', `${v.commit}:${v.path}`])).trim();
    } catch {
      v.blob = null; // not in that commit (an unusual --follow match)
    }
  }
  return versions;
}

/** The uncommitted version of the file, when it differs from HEAD (or is not committed yet). */
export async function workingVersion(top: string, rel: string, head: IFileVersion | undefined): Promise<IFileVersion | null> {
  const abs = path.join(top, rel);
  if (!existsSync(abs)) return null;
  const blob = (await git(top, ['hash-object', '--', rel])).trim();
  if (head && head.blob === blob && head.path === rel) return null;
  const { statSync } = await import('node:fs');
  return {
    commit: '',
    short: 'working',
    author: '',
    date: statSync(abs).mtime.toISOString(),
    subject: 'uncommitted changes',
    path: rel,
    status: 'W',
    blob,
  };
}

/** The bytes of a version (the working tree's from disk). */
export async function versionBytes(top: string, v: IFileVersion): Promise<Uint8Array> {
  if (v.status === 'W') return readModelFile(path.join(top, v.path));
  if (!v.blob) throw new Error('no content in this version');
  const raw = await gitBytes(top, ['cat-file', 'blob', v.blob]);
  const bytes = isLfsPointer(raw) ? await smudge(top, v.path, raw) : raw;
  if (path.posix.extname(v.path).toLowerCase() !== '.gltf') return bytes;
  // The .bin and images as they were in the same commit.
  const dir = path.posix.dirname(v.path);
  return inlineGltfResources(bytes, (rel) => gitBytes(top, ['cat-file', 'blob', `${v.commit}:${dir === '.' ? rel : `${dir}/${rel}`}`]).catch(() => null));
}

function isLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.length > 1024) return false;
  return new TextDecoder().decode(bytes.subarray(0, 64)).startsWith('version https://git-lfs.github.com/spec/');
}

/** A Git LFS pointer → the object, through `git lfs smudge` (needs git-lfs and the object). */
async function smudge(top: string, rel: string, pointer: Uint8Array): Promise<Uint8Array> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['lfs', 'smudge', '--', rel], { cwd: top });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => reject(new Error('stored with Git LFS, and git-lfs is not installed')));
    child.on('close', (code) => {
      const out = new Uint8Array(Buffer.concat(chunks));
      if (code !== 0 || isLfsPointer(out)) reject(new Error('stored with Git LFS, and the object is not available here (git lfs fetch)'));
      else resolve(out);
    });
    child.stdin.end(pointer);
  });
}

/** Where cached steps live: <git dir>/polymerge/log/. */
async function cacheDir(top: string): Promise<string> {
  const dir = (await git(top, ['rev-parse', '--git-path', 'polymerge/log'])).trim();
  return path.resolve(top, dir);
}

const metricsOnly = (mesh: IMesh): NonNullable<IHistoryStep['model']> => ({ ...computeMetrics(mesh), faces: mesh.faceCount, vertices: mesh.vertexCount });

/** What `version` did, compared with `previous` (both loaded). */
export function compareVersions(previous: IMesh | null, version: IMesh | null): IHistoryStep {
  return compareWithResult(previous, version).step;
}

function compareWithResult(previous: IMesh | null, version: IMesh | null): { step: IHistoryStep; result?: IDiffResult } {
  if (!version && previous) return { step: { kind: 'deleted', model: metricsOnly(previous) } };
  if (!version) return { step: { kind: 'unreadable', error: 'no content' } };
  if (!previous) return { step: { kind: 'added', model: metricsOnly(version) } };
  const result = diffMeshes(previous, version, { logger: silentLogger });
  const v = result.stats.vertices;
  const f = result.stats.faces;
  const changed = v.moved + v.added + v.removed + f.modified + f.added + f.removed > 0 || !result.alignment.isIdentity;
  const step: IHistoryStep = {
    kind: changed ? 'modified' : 'unchanged',
    tier: result.tier,
    stats: result.stats,
    metrics: result.metrics ?? compareMetrics(computeMetrics(previous), computeMetrics(version)),
    cad: result.brep?.changes.map((c) => c.description),
    regions: changeRegions(result, previous, version)
      .slice(0, 3)
      .map((r) => ({ side: r.side, faces: r.faces, center: r.center, size: r.size, maxDisplacement: r.maxDisplacement })),
  };
  return { step, result };
}

export interface IHistoryOptions {
  /** At most this many commits (default 20). */
  max?: number;
  /** Leave the uncommitted version out. */
  committedOnly?: boolean;
  /** Called as each version is compared (progress). */
  onStep?: (done: number, total: number) => void;
  /** Use and fill the cache in the git directory (default true). */
  cache?: boolean;
  /** Part of the cache key: results from another polymerge version are not reused. */
  engine: string;
}

/** The loaded versions, for the viewer (null where a version has no content or failed to load). */
export interface IHistory {
  top: string;
  rel: string;
  entries: IHistoryEntry[];
  /** entries[i]'s model, or null; only filled when `keepMeshes`. */
  meshes: (IMesh | null)[];
  /** The diff from the previous (older) readable version to entries[i]; only with `keepMeshes`. */
  results: (IDiffResult | null)[];
}

/**
 * The history of `file`: every version, newest first, each with what it changed. Versions are
 * loaded oldest first, so a STEP model is tessellated with ONE tolerance (the oldest version's)
 * throughout and unchanged surfaces stay unchanged.
 */
export async function modelHistory(file: string, o: IHistoryOptions, keepMeshes = false): Promise<IHistory> {
  const { top, rel } = await locate(file);
  const committed = await fileVersions(top, rel, o.max ?? 20);
  const working = o.committedOnly ? null : await workingVersion(top, rel, committed[0]);
  const versions = working ? [working, ...committed] : committed;
  if (versions.length === 0) throw new Error(`${rel} has no history in git yet (it is not committed, and not in the working tree)`);
  const cache = o.cache === false ? null : await cacheDir(top).catch(() => null);
  const entries: IHistoryEntry[] = versions.map((v) => ({ ...v, step: { kind: 'unreadable' } }));
  const meshes: (IMesh | null)[] = versions.map(() => null);
  const results: (IDiffResult | null)[] = versions.map(() => null);
  // Cached steps (keyed by this version's blob and the previous, older one's).
  const n = versions.length;
  const keys = versions.map((v, i) => (cache && v.blob !== undefined ? path.join(cache, `${o.engine}-${versions[i + 1]?.blob ?? 'none'}-${v.blob ?? 'deleted'}.json`) : null));
  const cached: (IHistoryStep | null)[] = await Promise.all(
    keys.map((k) => (k && !keepMeshes ? readFile(k, 'utf8').then((t) => JSON.parse(t) as IHistoryStep).catch(() => null) : Promise.resolve(null))),
  );
  // A version's model is needed for its own step and for the next newer one's.
  const needed = versions.map((_, i) => keepMeshes || !cached[i] || (i > 0 && !cached[i - 1]));
  let previous: IMesh | null = null;
  let previousUnreadable = false;
  let deflection: number | undefined;
  for (let i = n - 1; i >= 0; i--) {
    const v = versions[i];
    let mesh: IMesh | null = null;
    let failed: string | null = null;
    if (v.blob && v.status !== 'D' && needed[i]) {
      try {
        mesh = await loadModel(await versionBytes(top, v), path.basename(v.path), { stepDeflection: deflection });
        if (deflection === undefined) deflection = stepInfo(mesh)?.deflection;
      } catch (err) {
        failed = (err as Error).message;
      }
    }
    if (failed) entries[i].step = { kind: 'unreadable', error: failed };
    else if (cached[i]) entries[i].step = cached[i]!;
    else if (previousUnreadable && v.status !== 'D') entries[i].step = { kind: 'unreadable', model: mesh ? metricsOnly(mesh) : undefined, error: 'the version before it could not be read, so there is nothing to compare with' };
    else {
      const compared = compareWithResult(previous, v.status === 'D' ? null : mesh);
      entries[i].step = compared.step;
      if (keepMeshes) results[i] = compared.result ?? null;
      if (keys[i]) {
        await mkdir(path.dirname(keys[i]!), { recursive: true }).catch(() => {});
        await writeFile(keys[i]!, JSON.stringify(entries[i].step)).catch(() => {});
      }
    }
    if (keepMeshes) meshes[i] = mesh;
    previous = mesh;
    previousUnreadable = failed !== null;
    o.onStep?.(n - i, n);
  }
  return { top, rel, entries, meshes, results };
}
