import { diffMeshes, type IDiffLogger } from 'polymerge-core';
import { loadMeshFile, loadMeshPair } from '../io.js';
import { formatDiffReport } from '../report.js';

const NULL_FILES = new Set(['/dev/null', 'nul', 'NUL']);

/**
 * GIT_EXTERNAL_DIFF protocol (used through `diff.polymerge.command`):
 *   path old-file old-hex old-mode new-file new-hex new-mode [new-path xfrm-msg]
 * Must exit 0 on success, otherwise git aborts the whole diff.
 */
export async function runGitDiff(args: string[]): Promise<number> {
  if (args.length < 7) {
    process.stderr.write('polymerge git-diff: expected 7 arguments from git (path old-file old-hex old-mode new-file new-hex new-mode)\n');
    return 2;
  }
  const [repoPath, oldFile, , , newFile] = args;
  const newPath = args[7] ?? repoPath;
  const out = (s: string) => process.stdout.write(s + '\n');
  const header = repoPath === newPath ? repoPath : `${repoPath} → ${newPath}`;
  out(`polymerge diff --git a/${repoPath} b/${newPath}`);

  try {
    if (NULL_FILES.has(oldFile)) {
      const { mesh } = await loadMeshFile(newFile, newPath);
      out(`new model: ${header} (${mesh.vertexCount} vertices · ${mesh.faceCount} faces)`);
      return 0;
    }
    if (NULL_FILES.has(newFile)) {
      const { mesh } = await loadMeshFile(oldFile, repoPath);
      out(`deleted model: ${header} (${mesh.vertexCount} vertices · ${mesh.faceCount} faces)`);
      return 0;
    }
    const [base, target] = await loadMeshPair({ path: oldFile, name: repoPath }, { path: newFile, name: newPath });
    // Engine log lines go to the same stream as the report so they stay in order inside git's pager.
    const logger: IDiffLogger = { info: out, warn: out };
    const result = diffMeshes(base.mesh, target.mesh, { logger });
    out(
      formatDiffReport(result, base.mesh, target.mesh, {
        baseName: `a/${repoPath}`,
        targetName: `b/${newPath}`,
        topMoves: 5,
      }),
    );
  } catch (err) {
    out(`Binary files a/${repoPath} and b/${newPath} differ (polymerge could not diff: ${(err as Error).message})`);
  }
  return 0;
}

/** What `polymerge init` writes and `polymerge git-setup` prints: .gitattributes lines… */
export const GIT_ATTRIBUTES: readonly { pattern: string; attributes: string }[] = [
  ...['stl', 'obj', 'gltf', 'glb', 'ply'].map((e) => ({ pattern: `*.${e}`, attributes: 'diff=polymerge merge=polymerge' })),
  // STEP: diff only (needs the optional occt-import-js). It is text, but a line-by-line merge
  // corrupts it, so merge=binary keeps your side and marks the file conflicted instead.
  { pattern: '*.step', attributes: 'diff=polymerge merge=binary' },
  { pattern: '*.stp', attributes: 'diff=polymerge merge=binary' },
  // 3MF: a merged 3MF holds geometry and colours only, not the slicer project (settings, plates),
  // so git never writes one by itself: merge=binary marks the file conflicted, and
  // `polymerge resolve` merges it when you ask.
  { pattern: '*.3mf', attributes: 'diff=polymerge merge=binary' },
];

/** …and git config entries (the drivers). */
export const GIT_CONFIG: readonly [key: string, value: string][] = [
  ['diff.polymerge.command', 'polymerge git-diff'],
  ['difftool.polymerge.cmd', 'polymerge view "$LOCAL" "$REMOTE" --name "$MERGED"'],
  ['merge.polymerge.name', 'polymerge three-way 3D merge'],
  ['merge.polymerge.driver', 'polymerge git-merge %O %A %B %P'],
];

/** A value for a shell command line, quoted the way the README shows it. */
const shellArg = (v: string): string => (v.includes('"') ? `'${v}'` : `"${v}"`);

export function gitSetupText(): string {
  return [
    '# Or let polymerge do both steps: "polymerge init" (this repository) or "polymerge init --global".',
    '',
    '# 1) Tell git which files polymerge should diff and merge — add to .gitattributes:',
    ...GIT_ATTRIBUTES.filter((a) => !a.attributes.includes('merge=binary')).map((a) => `${a.pattern} ${a.attributes}`),
    '# STEP: diff only (needs the optional occt-import-js). It is text, but a line-by-line merge',
    '# corrupts it, so merge=binary keeps your side and marks the file conflicted instead.',
    '# 3MF: merged only when you ask ("polymerge resolve"), because a merged 3MF keeps the geometry',
    '# and colours but not the slicer project (settings, plates).',
    ...GIT_ATTRIBUTES.filter((a) => a.attributes.includes('merge=binary')).map((a) => `${a.pattern} ${a.attributes}`),
    '',
    '# 2) Register the drivers (drop --global to scope them to one repo):',
    ...GIT_CONFIG.map(([k, v]) => `git config --global ${k} ${shellArg(v)}`),
    '',
    '# 3) Use it:',
    'git diff -- model.stl                      # structural summary in the terminal',
    'git log -p --ext-diff -- model.stl         # history (log/show need --ext-diff)',
    'git difftool -y -t polymerge HEAD~1 -- model.stl   # visual diff in the browser',
    'git merge other-branch                     # models merged three-way; conflicts keep the base geometry',
    'polymerge resolve model.stl --pick 0=theirs && git add model.stl   # settle a conflicted model',
    '',
    `# (polymerge must be on PATH: "npm install -g @joshuahurley/polymerge", or in a clone "npm run build && npm link -w @joshuahurley/polymerge")`,
  ].join('\n');
}
