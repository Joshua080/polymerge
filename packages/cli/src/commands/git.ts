import { diffMeshes, type IDiffLogger } from '@polymerge/core';
import { loadMeshFile } from '../io.js';
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
    const [base, target] = await Promise.all([loadMeshFile(oldFile, repoPath), loadMeshFile(newFile, newPath)]);
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

export function gitSetupText(): string {
  const exts = ['stl', 'obj', 'gltf', 'glb'];
  return [
    '# 1) Tell git which files polymerge should diff and merge — add to .gitattributes:',
    ...exts.map((e) => `*.${e} diff=polymerge${e === 'stl' || e === 'obj' ? ' merge=polymerge' : ''}`),
    '',
    '# 2) Register the drivers (drop --global to scope them to one repo):',
    'git config --global diff.polymerge.command "polymerge git-diff"',
    `git config --global difftool.polymerge.cmd 'polymerge view "$LOCAL" "$REMOTE" --name "$MERGED"'`,
    'git config --global merge.polymerge.name "polymerge three-way 3D merge"',
    'git config --global merge.polymerge.driver "polymerge git-merge %O %A %B %P"',
    '',
    '# 3) Use it:',
    'git diff -- model.stl                      # structural summary in the terminal',
    'git log -p --ext-diff -- model.stl         # history (log/show need --ext-diff)',
    'git difftool -y -t polymerge HEAD~1 -- model.stl   # visual diff in the browser',
    'git merge other-branch                     # STL/OBJ merged three-way; conflicts keep the base geometry',
    'polymerge resolve model.stl --pick 0=theirs && git add model.stl   # settle a conflicted model',
    '',
    `# (polymerge must be on PATH: "npm install -g polymerge", or in a clone "npm run build && npm link -w polymerge")`,
  ].join('\n');
}
