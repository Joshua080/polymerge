# Changelog

All notable changes to polymerge. The command-line tool (`@joshuahurley/polymerge`) and the engine (`polymerge-core`) are released together, with the same version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow [Semantic Versioning](https://semver.org/). While the major version is 0, a minor release (0.x.0) can change behaviour.

How to add an entry and how releases are made: [CONTRIBUTING.md](CONTRIBUTING.md#changelog-and-releases).

## Unreleased

### Added
- **3MF and PLY**: read (3MF build items, components, units and colours; PLY ASCII and binary, polygons and face colours) and written as merge output. `init` sets PLY up for diff and merge, and 3MF for diff (a 3MF is merged only when you ask, because the merged file keeps the geometry but not the slicer project).
- **Geometry in every report**: size, volume (closed models only; an open one says why) and surface area, before and after, in the CLI, the viewer and the pull-request comment ("volume +2.3 cm³ (+4%)"). 3MF and STEP are in mm, glTF in metres; STL, OBJ and PLY in the file's own units.
- **Face-aware STEP diff**: CAD faces are recognised as planes, cylinders, cones and spheres and compared as surfaces: "hole Ø8 moved 5 mm (+5, 0, 0)", "hole Ø8 → Ø9", "new hole Ø6". Re-triangulation of an unchanged face no longer reads as a change. In `diff`, `info`, the viewer (a CAD faces panel) and the Action's comment.
- **Everything from a terminal**:
  - `polymerge section`: cut with a plane, list the outlines and holes, compare two versions' cuts, draw them as SVG;
  - `polymerge measure`: the distance between two points of the surface;
  - `diff` lists where the model changed (connected regions, with their size and largest move);
  - `info --json`, per-part sizes and volumes, and the CAD faces of a STEP file;
  - `resolve --dry-run`;
  - `--ascii`, automatic in the classic Windows console.
- **Review tools in the viewer**: a section plane (S), a distance measure (M) and a before / after slider (C).
- **Self-contained HTML**: `polymerge export old new` and the viewer's **Save as HTML** write one file with the viewer and the diff, which opens in any browser from disk, offline, with nothing to install.
- **A light theme** (the default) and a neutral dark one, switched in the viewer's header; the Inter typeface is bundled.
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
- **Million-triangle models**: faster spatial indexes make a million-triangle diff take seconds (about 1.5 s for Tier 1, 10 s for a re-meshed model). The Action renders models up to 2 million triangles and 150 MB by default (was 200,000 and 50 MB).
- The pull-request images are light, to match the viewer.
- Changes smaller than float rounding (1e-7 of a value) are reported as no change.

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
