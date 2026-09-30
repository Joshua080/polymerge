#!/usr/bin/env node
/**
 * polymerge PR diff, step 2 of 2: post. Takes the render step's output directory, publishes its
 * images to the image branch and creates or updates polymerge's single comment on the pull
 * request (found by a hidden marker). Node built-ins only: nothing to install.
 *
 * Two ways to run it (action.yml `mode`):
 *  - `all`, on a pull_request event, right after the render in the same job. For pull requests
 *    from this repository's own branches; a fork's pull_request token is read-only, so for a fork
 *    it only warns.
 *  - `post`, on a workflow_run event, in a separate privileged workflow, with the render job's
 *    artifact. The artifact was made by a run of the pull request's own code, so it is untrusted:
 *    the result is validated field by field (lib/validate.mjs), the pull request it names must
 *    have the head commit the triggering run built, and all text is escaped (lib/markdown.mjs).
 *
 * Either way, a result for a commit that is no longer the pull request's head is dropped: a newer
 * run will post.
 *
 * Environment:
 *   GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_SERVER_URL
 *   POLYMERGE_TOKEN            token with contents: write (image branch) + pull-requests: write
 *   POLYMERGE_RESULT           the render step's output directory
 *   POLYMERGE_IMAGE_BRANCH     (polymerge-images)
 *   POLYMERGE_COMMENT_AUTHOR   login the comment is posted as (github-actions[bot])
 */
import { appendSummary, errorAnnotation, log, readJson, setOutput, warning } from './lib/io.mjs';
import { findOwnComment, githubClient } from './lib/github.mjs';
import { imageUrl, publishImages } from './lib/images.mjs';
import { MARKER, buildComment, buildNoChangesComment } from './lib/markdown.mjs';
import { checkImages, readResult } from './lib/validate.mjs';

class Rejected extends Error {}

async function main() {
  const env = process.env;
  const repo = env.GITHUB_REPOSITORY ?? '';
  const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';
  const branch = env.POLYMERGE_IMAGE_BRANCH || 'polymerge-images';
  const author = env.POLYMERGE_COMMENT_AUTHOR || 'github-actions[bot]';
  const event = readJson(env.GITHUB_EVENT_PATH);
  const api = githubClient({ token: env.POLYMERGE_TOKEN, repo, apiUrl: env.GITHUB_API_URL || 'https://api.github.com' });

  const dir = env.POLYMERGE_RESULT;
  if (!dir) throw new Error('POLYMERGE_RESULT is not set');
  const result = readResult(dir);
  const images = checkImages(dir, result);

  // 1. Which pull request, and is this result for its current head commit?
  let pull;
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const run = event.workflow_run;
    if (!run || run.event !== 'pull_request') throw new Rejected('the triggering run was not a pull_request run');
    if (run.conclusion !== 'success') {
      log(`the render run concluded "${run.conclusion}"; nothing to post`);
      return;
    }
    if (result.head !== run.head_sha) throw new Rejected(`the artifact is for commit ${result.head.slice(0, 7)}, but the triggering run built ${String(run.head_sha).slice(0, 7)}`);
    const listed = Array.isArray(run.pull_requests) ? run.pull_requests.map((p) => p.number) : [];
    if (listed.length > 0 && !listed.includes(result.pr)) throw new Rejected(`the artifact names pull request #${result.pr}, which the triggering run does not belong to`);
    pull = await api.getPull(result.pr);
    if (pull.head?.sha !== run.head_sha) {
      // Either a newer push (its own run will post) or an artifact naming someone else's pull request.
      log(`pull request #${result.pr} is at ${String(pull.head?.sha).slice(0, 7)}, not ${run.head_sha.slice(0, 7)}: skipping`);
      return;
    }
    if (run.head_repository?.full_name && pull.head?.repo?.full_name !== run.head_repository.full_name) {
      throw new Rejected(`pull request #${result.pr} does not come from ${run.head_repository.full_name}`);
    }
  } else if (event.pull_request) {
    const pr = event.pull_request;
    if (result.pr !== pr.number || result.head !== pr.head?.sha) throw new Rejected('the result is not for this pull request');
    if (pr.head?.repo?.full_name && pr.head.repo.full_name !== repo) {
      warning(
        'polymerge: this pull request comes from a fork, and a pull_request run cannot comment on it (its token is read-only). Use the two-workflow setup (mode: render + mode: post) from docs/github-action.md.',
      );
      return;
    }
    pull = await api.getPull(pr.number);
    if (pull.head?.sha !== result.head) {
      log(`pull request #${pr.number} moved on to ${String(pull.head?.sha).slice(0, 7)}: skipping`);
      return;
    }
  } else {
    throw new Error(`unsupported event "${env.GITHUB_EVENT_NAME}": use pull_request (mode: all) or workflow_run (mode: post)`);
  }
  const number = pull.number ?? result.pr;

  // 2. The existing comment, if any.
  const existing = findOwnComment(await api.listComments(number), { marker: MARKER, author });
  if (result.files.length === 0) {
    if (existing) {
      await api.updateComment(existing.id, buildNoChangesComment(result.head));
      log(`no model changes any more: updated ${existing.html_url ?? `comment ${existing.id}`}`);
      setOutput('comment-url', existing.html_url ?? '');
    } else log('no model changes: nothing to post');
    return;
  }

  // 3. Images → the image branch, pinned by commit.
  const urls = new Map();
  if (images.length > 0) {
    const prefix = `pr-${number}/${result.head.slice(0, 12)}`;
    const commit = publishImages({
      remote: `${serverUrl.replace(/\/+$/, '')}/${repo}.git`,
      branch,
      files: images.map((i) => ({ path: `${prefix}/${i.name}`, file: i.file })),
      message: `polymerge: images for #${number} at ${result.head.slice(0, 7)}`,
      token: env.POLYMERGE_TOKEN,
    });
    for (const i of images) urls.set(i.name, imageUrl(serverUrl, repo, commit, `${prefix}/${i.name}`));
    log(`pushed ${images.length} image(s) to ${branch} at ${commit.slice(0, 7)}`);
  }

  // 4. The comment.
  const baseRef = typeof pull.base?.ref === 'string' ? pull.base.ref : null;
  const body = buildComment(result, { imageUrl: (name) => urls.get(name) ?? null, baseRef });
  const comment = existing ? await api.updateComment(existing.id, body) : await api.createComment(number, body);
  log(`${existing ? 'updated' : 'created'} ${comment?.html_url ?? 'the comment'}`);
  setOutput('comment-url', comment?.html_url ?? '');
  if (comment?.html_url) appendSummary(`polymerge comment: ${comment.html_url}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    const what = err instanceof Rejected ? 'rejected the render result' : 'failed';
    errorAnnotation(`polymerge ${what}: ${err instanceof Error ? err.message : String(err)}`);
    if (err?.status === 403 || /\b403\b/.test(err?.message ?? '')) errorAnnotation('polymerge: the token may not write here. It needs `contents: write` and `pull-requests: write` (see docs/github-action.md).');
    process.exit(1);
  },
);
