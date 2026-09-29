# polymerge in pull requests (GitHub Action)

When a pull request changes an STL, OBJ, glTF or GLB file, this action posts **one comment** on it:
a before / after image of every changed model, rendered from the same camera and coloured by what
changed, with a short structural summary. The comment is updated in place on every push.

![Before / after card: the separate part is yellow in both panels, where it was and where it is now; the rest is grey](images/action-card.png)

*One model's image (the `moved-part` example in this repository): before on the left, after on
the right, from the same camera. The separate part turned 30° and moved, so it is yellow in both;
everything grey is unchanged. Green would be added, red removed.*

For each model the comment shows:
- **the image**, both panels from one camera, so anything that differs between them really changed;
- **what changed**: moved parts (named when the file has named groups), vertices moved / added /
  removed, faces modified / added / removed, and a whole-model change such as `in → mm (×25.4)`;
- **how it was matched**: the correspondence tier (see the main README);
- **a command** to open the same diff in the interactive 3D viewer locally.

Added and deleted models get one panel (all green, or all red). Renames, mode-only changes,
re-exports with the same geometry, unreadable files, Git LFS pointers and models over the size
limits are listed with a one-line reason instead of an image.

> **Versions.** The examples use `Joshua080/polymerge@v1`. That tag does not exist yet: it will be
> created with the first release. Until then, pin a commit:
> `uses: Joshua080/polymerge@<full commit SHA>`. Pinning a SHA is also what GitHub recommends for
> third-party actions in general.

## Set it up

Pick one of the two setups. Both need **`fetch-depth: 0`** in `actions/checkout`: the diff is
taken against the pull request's merge base with the base branch, as GitHub's "Files changed"
tab does, so the history back to it is needed.

### Recommended: works for pull requests from forks too

Two workflows. The first renders with a read-only token; the second, triggered when the first
completes, posts the comment. A pull request from a fork never gets a write token, and this is
the standard safe way around that (see [Security](#security)).

```yaml
# .github/workflows/model-diff.yml
name: Model diff
on:
  pull_request:
permissions:
  contents: read
concurrency:
  group: model-diff-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  render:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: Joshua080/polymerge@v1
        with:
          mode: render
```

```yaml
# .github/workflows/model-diff-comment.yml
name: Model diff comment
on:
  workflow_run:
    workflows: [Model diff] # the name of the workflow above
    types: [completed]
permissions: {}
jobs:
  comment:
    if: github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      actions: read # download the render job's artifact
      contents: write # commit the images to the polymerge-images branch
      pull-requests: write # create / update the comment
    steps:
      - uses: Joshua080/polymerge@v1
        with:
          mode: post
```

GitHub runs `workflow_run` workflows only from the **default branch**, so the comment workflow
starts working once it is merged there; the pull request that adds it gets no comment.

### Simpler: pull requests from branches of the same repository only

One workflow. On a pull request from a fork it renders, writes the result to the job summary and
logs a warning that it cannot comment.

```yaml
# .github/workflows/model-diff.yml
name: Model diff
on:
  pull_request:
permissions:
  contents: write # commit the images to the polymerge-images branch
  pull-requests: write # create / update the comment
concurrency:
  group: model-diff-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  diff:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: Joshua080/polymerge@v1
```

### Don't filter by path

Leave out `paths:` filters. If a later push takes every model change back out of a pull request,
the run on that push is what updates the comment to say so; a path filter would skip it and leave
stale images behind. A run without model changes costs a few seconds: the action stops after one
`git diff`, before installing anything, and posts nothing unless there is a comment to update.

### Git LFS

If your models are in Git LFS, check them out with `lfs: true`:

```yaml
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
          lfs: true
```

The head versions then come from the local LFS store; older versions are fetched with `git lfs`
(keep the checkout's default `persist-credentials` for that in private repositories). Without
`lfs: true` a model in LFS is listed as "Git LFS file, not fetched" with this hint, never
reported as a parse error.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `mode` | `all` | `all`: render and comment in one job. `render`: render and upload the result as an artifact. `post`: download that artifact (in a `workflow_run` workflow) and comment. |
| `github-token` | `${{ github.token }}` | Token for the image branch and the comment, and in `post` mode for downloading the artifact. |
| `path` | `.` | The repository checkout to diff, relative to the workspace. |
| `max-files` | `10` | At most this many changed models are diffed and rendered; the rest are listed. |
| `max-triangles` | `200000` | Models with more triangles (either version) are listed, not rendered. |
| `max-file-size` | `50` | Models larger than this many MB are listed, not rendered. |
| `image-branch` | `polymerge-images` | Branch of your repository the images are committed to (created on first use). |
| `artifact-name` | `polymerge-pr-diff` | Name of the artifact that carries the result from `render` to `post`. |
| `comment-author` | `github-actions[bot]` | Login the comment is posted as, used to find it again. Change it only when `github-token` is not `GITHUB_TOKEN`. |

Outputs: `count` (changed model files), `rendered` (images), `result-dir` (result.json and the
PNGs, in `all` / `render` mode) and `comment-url`.

## How it works

1. **Changed models.** `git diff --raw -z -M <merge base> <head>`, filtered to `.stl`, `.obj`,
   `.gltf` and `.glb` in any letter case. Renames are detected; a rename with identical content,
   or a change of the file mode only, is listed without an image.
2. **Diff.** Each version is read from git (not from the working tree), checked for the size caps
   and for an LFS pointer, parsed by `polymerge-core` and diffed. A model whose geometry did not
   change (a re-export, a re-ordered file, or only a whole-model unit change) is listed with that
   explanation instead of two identical images.
3. **Render.** The built viewer (the same one `polymerge view` opens) runs in headless Chromium
   with software WebGL, in its capture mode (`?capture=1`): two panels with the same size, the
   same framing box and the same view direction, so their cameras are identical. The base version
   is drawn in the head's frame (aligned when the model was moved or rescaled as a whole), and
   the view turns to face the side of the model where the changes are. The card is 800 CSS px
   wide, the width of a GitHub comment, captured at 2× so it stays sharp on high-density screens
   and still reads on a phone; its dark background suits both light and dark themes. The
   rendering code is shared with the README images (`scripts/viewer-capture.mjs`).
4. **Publish.** The PNGs are committed to the image branch and the comment links them by
   commit-pinned URLs (below). The comment is found by a hidden marker on its first line and
   updated in place; a result for a commit that is no longer the pull request's head is dropped,
   because the newer push's run will post.

The action builds polymerge from its own checkout, so it needs no npm package. The build
(`node_modules` + the built packages) and Playwright's Chromium are cached with `actions/cache`,
keyed on the action's sources and its Playwright version. Only Chromium's headless shell is
downloaded, and system libraries are installed only if it cannot start without them.

## Image hosting

GitHub comments cannot show `data:` images, and workflow artifacts are zip downloads, not images.
The action therefore commits the PNGs to a branch of **your own repository** (`polymerge-images`
by default) and links them as

    https://github.com/<owner>/<repo>/raw/<commit>/pr-<number>/<head>/<n>.png

No third-party service and no secret beyond `GITHUB_TOKEN` is involved.

- **Commit-pinned.** Each run adds one commit on top of the branch, holding only that run's
  images; the branch's history keeps every earlier commit reachable, so the URLs in earlier
  versions of a comment keep working. The branch is never checked out, and its tree stays small.
- **Public repositories.** Anyone who can see the pull request can see the images.
- **Private repositories.** GitHub answers a `raw` URL for a signed-in user who can read the
  repository with a redirect to a short-lived tokened download, so people with access see the
  images and nobody else does. Expect images in notification e-mails not to load. (Neither was
  verified against a live private repository while the action was built.)
- **Size.** An image is typically 30–60 kB for simple models, more for dense ones. The branch
  grows with every push to a pull request that changes models. Delete the branch at any time to
  reclaim the space: it is recreated on the next run, and only the images of older comments stop
  loading.
- **Branch rules.** A ruleset or branch protection that covers every branch (for example,
  required signed commits) may refuse the push. Exempt `polymerge-images`, or set `image-branch`
  to a branch the rules allow.
- **Other workflows.** Pushes made with `GITHUB_TOKEN` start no workflow runs, so your CI does not
  run on the image branch. With a personal access token as `github-token`, add
  `branches-ignore: [polymerge-images]` to workflows triggered by `push`.

Other options considered: uploading as comment attachments (no API for it), release assets (a
release per image, and private repositories need a token to view them), GitHub Pages (must be
enabled, public, and deploys lag), a gist (needs a personal token), or an external image host
(needs an account and a secret).

## Security

- **Forks and `pull_request_target`.** A `pull_request` run from a fork gets a read-only token,
  so it cannot comment. The action never works around that with `pull_request_target` (which
  would run the fork's code with a write token). In the recommended setup the unprivileged
  `render` job produces an artifact, and the `workflow_run` job, which runs your default branch's
  workflow and never checks out the pull request, posts it.
- **The artifact is untrusted** in `post` mode: a fork can change the render workflow and upload
  anything. The post step:
  - rebuilds the result from known fields only, with checked types, lengths and enums;
  - accepts only images with its own names (`0.png`, …) that are regular files, real PNGs and
    within size limits;
  - requires the pull request named in the artifact to be at exactly the commit the triggering
    run built (so a result cannot be posted to another pull request, or for a stale commit);
  - generates all wording itself. Text from the pull request (file names, part names, parser
    messages) appears only inside markdown code spans, where it cannot become HTML, links,
    mentions or formatting; invisible and direction-changing characters are shown as escapes.

  What remains possible is inherent to rendering someone's pull request: its author, who
  controls their own render run, can make the comment on *their own* pull request show any
  PNG within the limits. They cannot post to another pull request, or anything but that comment.
- **No code from the pull request runs.** Model files are only read from git and parsed. File
  names never reach a shell: git runs with argument arrays, inputs reach the scripts as
  environment variables, and the page is given the models under fixed names. Untrusted text is
  printed to the job log with a prefix on every line, so it cannot issue workflow commands.
- **The comment** is found by its marker *and* its author, so a comment in which someone pasted
  the marker is never edited.
- **Minimal permissions**, as in the examples above: `contents: read` to render;
  `contents: write`, `pull-requests: write` and `actions: read` to post.

## Limits

- Linux runners (`ubuntu-latest`) are what the action is built and tested for.
- At most `max-files` models are rendered per comment (10), each up to `max-triangles` (200,000)
  and `max-file-size` (50 MB); the rest are listed. A comment is kept under GitHub's 65,536
  character limit by dropping per-file details first.
- The diff's own limits apply (README, "What v1 does and doesn't handle"), including `.gltf`
  files with external buffers, which cannot be read.
- The camera is the viewer's 3/4 view turned towards the changes; a change hidden inside the model
  (a cavity) may not be visible, but it is still in the summary.
- One comment per pull request per repository: two workflows using this action on the same
  pull request would edit the same comment.

## Development

The implementation is in [`action/`](../action): `render.mjs` (find, diff and render),
`post.mjs` (validate, publish, comment) and `lib/` (the pure pieces, unit-tested in
`action/test/`). `scripts/e2e-action.mjs`, part of `npm run e2e`, runs both steps against a real
temporary git repository, headless Chromium, a mock GitHub API and a local bare repository as
the image remote. This repository uses the action on its own pull requests through
`.github/workflows/model-diff.yml` and `model-diff-comment.yml`.
