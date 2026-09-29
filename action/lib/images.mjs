/**
 * Image hosting for the comment: the PNGs are committed to a dedicated branch of the same
 * repository (default `polymerge-images`) and referenced by commit-pinned URLs,
 *
 *   <server>/<owner>/<repo>/raw/<commit>/<path>
 *
 * The commit is built with git plumbing in a scratch repository (no checkout, nothing of the pull
 * request's code runs) and pushed on top of the branch. Each commit's tree holds only that run's
 * images, while the branch history keeps every earlier commit reachable, so URLs in older comment
 * versions keep working. A concurrent push (another pull request's run) is retried on the new tip.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, gitTry } from './io.mjs';

const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };

/** A branch name git accepts and that cannot be read as an option or a ref expression. */
export function checkBranchName(branch) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock') || branch.includes('//')) {
    throw new Error(`image-branch "${branch}" is not a usable branch name`);
  }
  return branch;
}

/** The commit-pinned URL of a file on the image branch. */
export function imageUrl(serverUrl, repo, commit, filePath) {
  return `${serverUrl.replace(/\/+$/, '')}/${repo}/raw/${commit}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Commit `files` ([{ path: 'pr-7/<head>/0.png', file: '/abs/0.png' }]) to `branch` of `remote`
 * and push. `token` authenticates https remotes (an HTTP header passed through the environment,
 * never on the command line). Returns the new commit id.
 * @param {{ remote: string, branch: string, files: { path: string, file: string }[], message: string, token?: string, attempts?: number }} options
 * @returns {string}
 */
export function publishImages({ remote, branch, files, message, token, attempts = 5 }) {
  checkBranchName(branch);
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'polymerge-images-'));
  /** @type {Record<string, string>} */
  const env = {
    GIT_DIR: dir,
    GIT_INDEX_FILE: path.join(dir, 'polymerge.index'),
    GIT_AUTHOR_NAME: BOT.name,
    GIT_AUTHOR_EMAIL: BOT.email,
    GIT_COMMITTER_NAME: BOT.name,
    GIT_COMMITTER_EMAIL: BOT.email,
  };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  try {
    git(dir, ['init', '-q', '--bare', dir], { env });
    for (const f of files) {
      const blob = git(dir, ['hash-object', '-w', '--', f.file], { env }).trim();
      git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${f.path}`], { env });
    }
    const tree = git(dir, ['write-tree'], { env }).trim();
    const ref = `refs/heads/${branch}`;
    let lastError = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // The branch tip (if the branch exists) becomes the parent.
      const fetched = gitTry(dir, ['fetch', '-q', '--depth=1', '--no-tags', remote, ref], { env });
      let parent = null;
      if (fetched.status === 0) parent = git(dir, ['rev-parse', 'FETCH_HEAD'], { env }).trim();
      else if (!/couldn't find remote ref|could not find remote ref/i.test(fetched.stderr)) throw new Error(`could not read the ${branch} branch: ${fetched.stderr}`);
      // Never signed with whatever key the runner's git config names: these are the bot's commits.
      const commit = git(dir, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { env }).trim();
      const pushed = gitTry(dir, ['push', '-q', remote, `${commit}:${ref}`], { env });
      if (pushed.status === 0) return commit;
      lastError = pushed.stderr;
      // Someone else moved the branch in between: build on the new tip and try again.
      if (!/non-fast-forward|fetch first|rejected|failed to update ref|cannot lock ref/i.test(pushed.stderr)) break;
    }
    throw new Error(`could not push the images to the ${branch} branch: ${lastError}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
