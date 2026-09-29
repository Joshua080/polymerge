/**
 * "Save to repository" for `polymerge review <path>`: write the resolved model to <path> and
 * `git add` it. The threat model and the reason for every check: docs/write-back-security.md.
 *
 *  - The path is fixed when the session opens, from the command line, and must be an unmerged
 *    index entry with all three stages (§4.6). A request never names a path.
 *  - A save request carries resolution CHOICES only. The file is recomputed here from the stage
 *    blobs read at startup, through `polymerge resolve`'s own code (resolveStages), so a stolen
 *    token can only choose between versions already in the index (§4.5).
 *  - Before the file is replaced (atomically, by rename), the parent directory, the file type,
 *    its contents and the index stages are all checked against what they were at startup.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MergeResolution } from 'polymerge-core';
import { outputFormat, resolveStages, type MergeCommandOptions } from './commands/merge.js';
import { newToken } from './serve-guard.js';

const execFileP = promisify(execFile);

type StageNo = 1 | 2 | 3;
const STAGES: readonly StageNo[] = [1, 2, 3];
/** Index modes of a regular file (not a symlink 120000 or a submodule 160000). */
const REGULAR_MODES = new Set(['100644', '100755']);
const SIDES: ReadonlySet<string> = new Set<MergeResolution>(['ours', 'theirs', 'base']);
const REQUEST_FIELDS: ReadonlySet<string> = new Set(['picks', 'acknowledgeWarnings', 'expect']);

interface IStageEntry {
  mode: string;
  oid: string;
}

/** What the viewer is told about the session (GET /api/review/session). */
export interface IReviewSessionInfo {
  /** The file, as the index names it (root-relative, "/" separators). */
  path: string;
  /** Its file name: the name the writer puts in the file, and the viewer hashes with. */
  name: string;
  /** Output format, when writable. */
  format?: string;
  writable: boolean;
  /** Why saving is unavailable, when it is. */
  reason?: string;
}

/** The body of every save response. `written` without `staged` = the file changed but git add failed. */
export interface ISaveResponse {
  ok: boolean;
  written: boolean;
  staged: boolean;
  path: string;
  message: string;
  /** Machine-readable reason for a refusal (e.g. "changed", "unresolved", "warnings"). */
  code?: string;
  warnings?: string[];
}

export interface ISaveResult {
  status: number;
  body: ISaveResponse;
}

export interface ISaveRequest {
  picks: Map<number, MergeResolution>;
  acknowledgeWarnings: boolean;
  /** SHA-256 (hex) of the file the viewer would write. */
  expect: string;
}

export class BadSaveRequest extends Error {}

/**
 * Validate a save request body strictly: exactly `picks`, `acknowledgeWarnings` (optional) and
 * `expect`. Any other field — a path, a format, file content — is refused, not ignored.
 */
export function parseSaveRequest(body: unknown): ISaveRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadSaveRequest('the body must be a JSON object');
  for (const key of Object.keys(body)) {
    if (!REQUEST_FIELDS.has(key)) throw new BadSaveRequest(`unknown field "${key}": a save carries resolution choices only`);
  }
  const { picks, acknowledgeWarnings, expect } = body as Record<string, unknown>;
  if (typeof picks !== 'object' || picks === null || Array.isArray(picks)) throw new BadSaveRequest('"picks" must be an object of conflict id → ours | theirs | base');
  const out = new Map<number, MergeResolution>();
  for (const [id, side] of Object.entries(picks)) {
    if (!/^(0|[1-9]\d{0,6})$/.test(id)) throw new BadSaveRequest(`bad conflict id "${id}"`);
    if (typeof side !== 'string' || !SIDES.has(side)) throw new BadSaveRequest(`conflict #${id}: the choice must be ours, theirs or base`);
    out.set(Number(id), side as MergeResolution);
  }
  if (acknowledgeWarnings !== undefined && typeof acknowledgeWarnings !== 'boolean') throw new BadSaveRequest('"acknowledgeWarnings" must be true or false');
  if (typeof expect !== 'string' || !/^[0-9a-f]{64}$/.test(expect)) throw new BadSaveRequest('"expect" must be the SHA-256 (hex) of the file the viewer shows');
  return { picks: out, acknowledgeWarnings: acknowledgeWarnings === true, expect };
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 << 20, timeout: 60_000, windowsHide: true });
  return stdout;
}

async function gitBlob(cwd: string, oid: string): Promise<Uint8Array> {
  const { stdout } = await execFileP('git', ['cat-file', 'blob', oid], { cwd, encoding: 'buffer', maxBuffer: 1 << 30, timeout: 60_000, windowsHide: true });
  return new Uint8Array(stdout);
}

const gitError = (err: unknown): string => {
  const e = err as { stderr?: string | Buffer; message?: string };
  return (e.stderr ? String(e.stderr) : '').trim() || (e.message ?? String(err));
};

/**
 * The unmerged index entries for exactly `indexPath` (literal pathspec: `*.stl` is a file name,
 * not a glob), or null unless stages 1, 2 and 3 are all present.
 */
async function unmergedStages(root: string, indexPath: string): Promise<Record<StageNo, IStageEntry> | null> {
  const out = await git(root, ['--literal-pathspecs', 'ls-files', '-u', '-z', '--', indexPath]);
  const stages: Partial<Record<StageNo, IStageEntry>> = {};
  for (const entry of out.split('\0')) {
    const m = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t([\s\S]*)$/.exec(entry);
    if (m && m[4] === indexPath) stages[Number(m[3]) as StageNo] = { mode: m[1], oid: m[2] };
  }
  return stages[1] && stages[2] && stages[3] ? (stages as Record<StageNo, IStageEntry>) : null;
}

type Resolver = typeof resolveStages;

/** One review session's write capability. Open it with `ReviewWriteBack.open`. */
export class ReviewWriteBack {
  /** The session token (§4.3): new per process, never stored. */
  readonly token = newToken();
  private busy = false;
  private saved = false;

  private constructor(
    /** Real path of the work-tree root. */
    readonly root: string,
    /** The file as the index names it: root-relative, "/" separators. */
    readonly indexPath: string,
    /** Absolute path written: root + indexPath (the index's spelling). */
    readonly file: string,
    /** Real path of the file's directory when the session opened. */
    private readonly parent: string,
    private readonly stageEntries: Record<StageNo, IStageEntry>,
    /** The stage blobs: served to the viewer and merged on save. */
    readonly stages: Record<StageNo, Uint8Array>,
    /** SHA-256 of the work-tree file as the session expects it (at startup, then as last saved). */
    private diskHash: string | null,
    private readonly format: string | undefined,
    private readonly reason: string | undefined,
    private readonly resolve: Resolver,
  ) {}

  /**
   * Resolve `pathArg` (relative to `cwd`) to its unmerged index entry and read the three stages.
   * Throws when it is not an unresolved conflict with all three stages inside a work tree (the
   * review cannot open). Anything that only prevents SAVING leaves the session read-only, with
   * a reason (`info().reason`).
   */
  static async open(pathArg: string, cwd = process.cwd(), options: { resolve?: Resolver } = {}): Promise<ReviewWriteBack> {
    let top: string;
    try {
      top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    } catch (err) {
      throw new Error(`${pathArg}: not inside a git work tree (${gitError(err)})`);
    }
    const root = await realpath(top);
    const abs = path.resolve(cwd, pathArg);
    let parent: string;
    try {
      parent = await realpath(path.dirname(abs));
    } catch {
      throw new Error(`${pathArg}: no such directory`);
    }
    const rel = path.relative(root, path.join(parent, path.basename(abs)));
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`${pathArg} is outside the repository's work tree (${root})`);
    }
    const indexPath = rel.split(path.sep).join('/');
    const entries = await unmergedStages(root, indexPath);
    if (!entries) throw new Error(`git has no stages :1 / :2 / :3 for ${indexPath}: is it an unresolved merge conflict? (git status)`);
    const blobs = await Promise.all(STAGES.map((n) => gitBlob(root, entries[n].oid)));
    const stages = { 1: blobs[0], 2: blobs[1], 3: blobs[2] };
    const file = path.join(root, ...indexPath.split('/'));

    // Anything below only turns saving off.
    let reason: string | undefined;
    let format: string | undefined;
    let diskHash: string | null = null;
    const special = STAGES.find((n) => !REGULAR_MODES.has(entries[n].mode));
    if (special) reason = `${indexPath} is not a regular file in git (stage ${special} has mode ${entries[special].mode})`;
    try {
      format = outputFormat(indexPath);
    } catch (err) {
      reason ??= (err as Error).message;
    }
    try {
      const st = await lstat(file);
      if (st.isSymbolicLink()) reason ??= `${indexPath} is not a regular file (symbolic link)`;
      else if (!st.isFile()) reason ??= `${indexPath} is not a regular file`;
      else diskHash = sha256(await readFile(file));
    } catch {
      reason ??= `${indexPath} does not exist in the work tree`;
    }
    return new ReviewWriteBack(root, indexPath, file, parent, entries, stages, diskHash, reason ? undefined : format, reason, options.resolve ?? resolveStages);
  }

  get writable(): boolean {
    return this.reason === undefined;
  }

  info(): IReviewSessionInfo {
    const out: IReviewSessionInfo = { path: this.indexPath, name: path.posix.basename(this.indexPath), writable: this.writable };
    if (this.format) out.format = this.format;
    if (this.reason) out.reason = this.reason;
    return out;
  }

  /** Handle a parsed JSON save request. Never throws; every outcome is a status + body. */
  async save(body: unknown): Promise<ISaveResult> {
    const refuse = (status: number, code: string, message: string, extra: Partial<ISaveResponse> = {}): ISaveResult => ({
      status,
      body: { ok: false, written: false, staged: false, path: this.indexPath, code, message, ...extra },
    });
    let request: ISaveRequest;
    try {
      request = parseSaveRequest(body);
    } catch (err) {
      return refuse(400, 'bad-request', (err as Error).message);
    }
    if (!this.writable) return refuse(422, 'not-writable', `Saving is unavailable: ${this.reason}`);
    if (this.saved) return refuse(409, 'saved', `${this.indexPath} was already saved and staged in this session.`);
    if (this.busy) return refuse(409, 'busy', 'A save is already in progress.');
    this.busy = true;
    try {
      return await this.saveLocked(request, refuse);
    } finally {
      this.busy = false;
    }
  }

  private async saveLocked(
    request: ISaveRequest,
    refuse: (status: number, code: string, message: string, extra?: Partial<ISaveResponse>) => ISaveResult,
  ): Promise<ISaveResult> {
    // 1. Recompute the file from the stages read at startup, exactly as `polymerge resolve --pick …`.
    const pick = [...request.picks].sort(([a], [b]) => a - b).map(([id, side]) => `${id}=${side}`);
    let computed: Awaited<ReturnType<Resolver>>;
    try {
      computed = await this.resolve((n) => this.stages[n], this.indexPath, { pick });
    } catch (err) {
      return refuse(500, 'compute', `Could not compute the merged file: ${(err as Error).message}. Nothing was written.`);
    }
    const { result, bytes } = computed;

    // 2. Semantics (§4.8): known ids, every conflict explicitly resolved, warnings acknowledged.
    const ids = new Set(result.conflicts.map((c) => c.id));
    const unknown = [...request.picks.keys()].filter((id) => !ids.has(id));
    if (unknown.length > 0) return refuse(400, 'bad-request', `No conflict ${unknown.map((id) => `#${id}`).join(', ')} in this merge.`);
    const unresolved = result.conflicts.filter((c) => c.resolution === null);
    if (unresolved.length > 0 || !result.clean) {
      return refuse(422, 'unresolved', `${unresolved.length} conflict(s) are unresolved (${unresolved.map((c) => `#${c.id}`).join(', ')}). Choose ours, theirs or base for every conflict before saving.`);
    }
    const warnings = result.warnings.map((w) => w.message);
    if (warnings.length > 0 && !request.acknowledgeWarnings) {
      return refuse(422, 'warnings', `The chosen resolutions combine into damage (${warnings.length} warning(s)). Confirm to save anyway.`, { warnings });
    }

    // 3. What you saw is what gets written (§4.5).
    if (sha256(bytes) !== request.expect) {
      return refuse(409, 'mismatch', 'The merge computed from the repository differs from the one in the viewer, so nothing was written. Use the command shown in the viewer (polymerge resolve) instead.');
    }

    // 4. Write to an exclusive temp file next to the target, recheck everything, then rename (§4.6).
    const dir = path.dirname(this.file);
    const tmp = path.join(dir, `.${path.basename(this.file)}.polymerge-${randomBytes(6).toString('hex')}.tmp`);
    let renamed = false;
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const check = await this.recheck();
      if ('code' in check) return refuse(409, check.code, check.message);
      await chmod(tmp, check.mode & 0o777);
      await rename(tmp, this.file);
      renamed = true;
    } catch (err) {
      return refuse(500, 'write', `Could not write ${this.indexPath}: ${(err as Error).message}. Nothing was changed.`);
    } finally {
      if (!renamed) await rm(tmp, { force: true }).catch(() => {});
    }
    // A retry after a failed `git add` must see the file as this session left it.
    this.diskHash = sha256(bytes);

    // 5. Stage it (§4.7). Never commit.
    const addCommand = `git add -- ${this.indexPath}`;
    try {
      await git(this.root, ['--literal-pathspecs', 'add', '--', this.indexPath]);
    } catch (err) {
      return {
        status: 500,
        body: {
          ok: false,
          written: true,
          staged: false,
          path: this.indexPath,
          code: 'git-add',
          message: `Saved ${this.indexPath}, but git add failed: ${gitError(err)}. Fix that and save again, or run: ${addCommand}`,
        },
      };
    }
    const left = await git(this.root, ['--literal-pathspecs', 'ls-files', '-u', '-z', '--', this.indexPath]).catch(() => 'unknown');
    if (left !== '') {
      return {
        status: 500,
        body: { ok: false, written: true, staged: false, path: this.indexPath, code: 'git-add', message: `Saved ${this.indexPath}, but git still lists it as unmerged. Run: ${addCommand}` },
      };
    }
    this.saved = true;
    return {
      status: 200,
      body: { ok: true, written: true, staged: true, path: this.indexPath, message: `Saved ${this.indexPath} and staged it (git add). Nothing was committed.` },
    };
  }

  /** Everything that must still be as it was at startup, just before the rename. */
  private async recheck(): Promise<{ mode: number } | { code: string; message: string }> {
    const p = this.indexPath;
    let parent: string;
    try {
      parent = await realpath(path.dirname(this.file));
    } catch {
      parent = '';
    }
    if (parent !== this.parent) return { code: 'moved', message: `The directory of ${p} was moved or replaced (e.g. by a symbolic link) since the review started. Nothing was written.` };
    let st;
    try {
      st = await lstat(this.file);
    } catch {
      return { code: 'missing', message: `${p} no longer exists. Nothing was written.` };
    }
    if (!st.isFile()) return { code: 'not-regular', message: `${p} was replaced by ${st.isSymbolicLink() ? 'a symbolic link' : 'something that is not a regular file'} since the review started. Nothing was written.` };
    if (sha256(await readFile(this.file)) !== this.diskHash) {
      return { code: 'changed', message: `${p} changed on disk since the review started. Your changes were kept and nothing was written; restart polymerge review to review the current state.` };
    }
    const now = await unmergedStages(this.root, p).catch(() => null);
    if (!now) return { code: 'not-conflicted', message: `${p} is no longer an unresolved merge conflict (git status). Nothing was written.` };
    if (STAGES.some((n) => now[n].oid !== this.stageEntries[n].oid || now[n].mode !== this.stageEntries[n].mode)) {
      return { code: 'stages-changed', message: `git's conflict stages for ${p} changed since the review started. Nothing was written.` };
    }
    return { mode: st.mode };
  }
}
