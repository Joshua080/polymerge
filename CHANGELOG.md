# Changelog

All notable changes to polymerge. The command-line tool (`@joshuahurley/polymerge`) and the engine (`polymerge-core`) are released together, with the same version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow [Semantic Versioning](https://semver.org/). While the major version is 0, a minor release (0.x.0) can change behaviour.

How to add an entry and how releases are made: [CONTRIBUTING.md](CONTRIBUTING.md#changelog-and-releases).

## Unreleased

### Added
- **STEP files** (`.step`, `.stp`) in `diff`, `info`, `view`, `git-diff`, the pull-request Action and the hosted viewer. They are read with OpenCascade (`occt-import-js`, LGPL-2.1), an optional download that polymerge never installs by itself. Merging STEP is refused.
- **Z-up view** for CAD and 3D-printing models:
  - a menu in the viewer and `?up=z` in its address;
  - `--up z` on `view`, `review` and `demo`;
  - the Action's `up-axis` input.

  STEP files open Z up.
- **Colour-blind-safe palette**: blue added, orange removed and yellow moved; in the merge review, ours blue and theirs yellow.
  - In the viewer it is a menu, remembered in each browser, or `?palette=colorblind`.
  - On the command line it is `--palette colorblind`; in the Action, the `palette` input.
- **`polymerge init`**: sets git up (`.gitattributes` and the diff and merge drivers) for this repository, or for every repository with `--global`.
- **The viewer on GitHub Pages** (<https://joshua080.github.io/polymerge/>). It opens models from any https site by link. A model's panel says which site it came from, and a blocked download explains why it failed.
- **Releases from a pull request.** A "Prepare release" workflow opens the version bump; merging it publishes to npm, tags the release, writes the GitHub Release and moves `v1`.
- Community files: a code of conduct, a contributing guide, a security policy, issue and pull request templates, and this changelog.

### Changed
- `polymerge git-setup` points to `polymerge init`, and both write the same lines.

## 0.2.0 - 2026-10-05

The first release of the command-line tool, `@joshuahurley/polymerge`.

### Added
- **The `polymerge` command:**
  - `diff`, `info` and `merge`;
  - `view` (two files: the diff; three files: the merge review) and `demo`;
  - the git drivers `git-diff` and `git-merge`, with `git-setup`, `resolve` and `review`.
- **Merge review in the browser.** Conflicts are highlighted, each side can be previewed in place, and one click resolves a conflict. From `polymerge review <path>`, "Save to repository" writes and stages the result; this works on localhost only, with a per-session token.
- **Pull-request GitHub Action** (`Joshua080/polymerge@v1`): one comment per pull request with before/after images and a structural summary. A two-workflow setup makes it safe for pull requests from forks.
- **glTF and GLB output** for merges, keeping the base model's nodes, names and transforms.
- **Appearance merge for glTF and GLB:** materials, face materials, UVs and texture references, with their own conflicts.

## 0.1.0 - 2026-09-28

The first publication of the engine, `polymerge-core`. The command-line tool was not published, because npm refused its unscoped name.

### Added
- Loading STL, OBJ, glTF and GLB into one welded mesh form.
- Vertex correspondence in three tiers (index or ID, topological, point cloud), recognising moved parts and unit changes.
- Three-way merge with per-region conflicts and a collision check, and STL and OBJ writers.
