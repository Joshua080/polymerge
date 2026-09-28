# polymerge

[![CI](https://github.com/Joshua080/polymerge/actions/workflows/ci.yml/badge.svg)](https://github.com/Joshua080/polymerge/actions/workflows/ci.yml)

**Diff and three-way merge for 3D models (STL, OBJ, glTF/GLB), with a visual review in the browser and drivers for git.**

Most 3D "diff" tools paint a heatmap of how far two surfaces are apart. polymerge works out which vertex in the old model *became* which vertex in the new one, even when the file was re-exported, re-ordered, converted from inches to millimetres, or had a part moved. On top of that correspondence it can:
- tell you exactly what changed;
- merge two people's edits to the same model the way git merges text: independent changes are combined, and real conflicts are shown to you to decide.

![Merge review: the conflict is orange; hover previews each side; clicking Theirs resolves it](docs/images/merge-review.gif)

*Merge review (`polymerge view base.stl ours.stl theirs.stl`).*
- Automatic edits from each side are blue and purple; the conflict is orange.
- Clicking the conflict shows both versions in place, and hovering a button previews that version.
- One click resolves it.

![Diff viewer: moved vertices yellow, added green, removed red](docs/images/diff-viewer.png)

*Diff viewer (`polymerge view old.obj new.obj`).*
- One edit moved a patch (yellow), deleted another (red) and added a strip (green).
- The file's face order was also shuffled.
- The panel shows how the correspondence was found and the counts.

## Install

polymerge needs **Node.js 20 or newer**.

```bash
npm install -g polymerge
polymerge demo            # opens the merge review on a built-in example — no files needed
```

Or run it without installing: `npx polymerge demo`.

> **Release status:** the packages are ready to publish (see [Releasing](#releasing)) but **not on npm yet**. Until the first release, install from source:
>
> ```bash
> git clone https://github.com/Joshua080/polymerge.git && cd polymerge
> npm install && npm run build
> npm link -w polymerge          # puts `polymerge` on your PATH
> ```

`polymerge view`, `review` and `demo` start a small local web server (bound to 127.0.0.1) and open your browser. The viewer is bundled in the package. It uses WebGL and runs entirely on your machine; nothing is uploaded.

## Using it

The examples below are real runs. The files are in this repository: `fixtures/cases/` holds the diff pairs, and `examples/plate/` holds a three-way merge example.

### Diff two models

```console
$ polymerge diff fixtures/cases/mixed-topology-edit/base.obj fixtures/cases/mixed-topology-edit/target.obj --top 3
polymerge diff
  base   base.obj  OBJ  169 vertices · 288 faces
  target target.obj  OBJ  169 vertices · 276 faces

Correspondence: Tier 2 · topological (geometric + adjacency)
  ✗ Tier 1  score 0.007 < 0.950  index mode: 0.7% of the smaller mesh's faces preserved (2/276), …
  ✓ Tier 2  score 0.974 ≥ 0.600  161 seed(s) within moveEpsilon, 4 propagated, … edge consistency 99.8%

Vertices  unchanged 161  moved 4  added 4  removed 4
Faces     unchanged 254  modified 16  added 6  removed 18
Displacement  max 0.2500  mean 0.2500

Largest vertex moves (3 of 4):
  base #29 → target #77  Δ (0, 0, 0.2500)  |Δ| 0.2500
  base #28 → target #78  Δ (0, 0, 0.2500)  |Δ| 0.2500
  base #41 → target #83  Δ (0, 0, 0.2500)  |Δ| 0.2500
```

A model re-exported in other units reads as one unit conversion, not as every vertex moving. Here the part was also rotated and its file re-ordered:

```console
$ polymerge diff fixtures/cases/units-inch-to-mm/base.stl fixtures/cases/units-inch-to-mm/target.obj
…
Correspondence: Tier 3 · point cloud (ICP + nearest surface)
Vertices  unchanged 46  moved 0  added 0  removed 0
Faces     unchanged 88  modified 0  added 0  removed 0
Alignment  units in → mm (×25.4), rotation 90.00° about (0.000, 0.000, 1.000), translation (10.0000, 20.0000, 1.511e-7), rms 9.445e-7
```

A part moved on its own reads as a *moved part*, not as removed + added:

```console
$ polymerge diff fixtures/cases/moved-part/base.obj fixtures/cases/moved-part/target.obj
…
Vertices  unchanged 46  moved 46  added 0  removed 0
Moved parts (1):
  • "base": rotation 30.00°, centroid shift (-2.073e-8, 2.5000, 0.5000) [re-matched (was removed + added)]
```

Useful options:
- `--json out.json` (or `--json -`) writes the full result: every vertex correspondence and status;
- `--exit-code` exits 1 when the models differ, like `git diff --exit-code`;
- `-q` prints no report.

### Look at a diff in 3D

```bash
polymerge view old.stl new.obj
```

Colours:
- green: added;
- red: removed;
- yellow: moved or modified;
- grey: unchanged.

Click any vertex to read its correspondence, e.g. *base #29 → target #77, Δ (0, 0, 0.25)*. The two files can be different formats.

### Three-way merge

Give it the common ancestor (base) and the two edited versions (ours, theirs):

```console
$ polymerge merge examples/plate/base.stl examples/plate/ours.stl examples/plate/theirs.stl -o merged.stl
polymerge merge
  base    base.stl
  ours    ours.stl  (Tier 1)
  theirs  theirs.stl  (Tier 1)
Frame      base frame
Applied    ours: 1 moved vertex(es), 0 deletion(s), 0 new face(s)
           theirs: 1 moved vertex(es), 0 deletion(s), 0 new face(s)
           identical on both: 0 change(s)
Conflicts (1):
  #0 [move-move] 9 vertex(es) moved to different places by ours and theirs
      9 base vertex(es) near (4.000, 4.000, 1.000)  unresolved (base kept)
Result: 1 unresolved conflict(s) — those regions keep the BASE geometry. Resolve with --resolve ours|theirs or --pick <id>=ours|theirs.
Wrote merged.stl
$ echo $?
1
```

Both sides raised the same boss to different heights, which is a conflict. Each side's other edit (a bevelled corner) was applied automatically.

A conflict region keeps the **base** geometry until you choose; polymerge never guesses. Choose per region, or for all of them:

```console
$ polymerge merge examples/plate/base.stl examples/plate/ours.stl examples/plate/theirs.stl -o merged.stl --pick 0=theirs
…
  #0 [move-move] 9 vertex(es) moved to different places by ours and theirs
      9 base vertex(es) near (4.000, 4.000, 1.000)  → theirs
Result: clean — 162 vertices · 320 faces
Wrote merged.stl
```

`--resolve ours|theirs|base` resolves every conflict at once. `--report conflicts.json` writes the conflicts and statistics as JSON.

**What conflicts.** The rules are in [docs/merge-design.md](docs/merge-design.md). In short:
- the same vertex moved differently on the two sides;
- a vertex deleted on one side while the other side edited it or built on it;
- different geometry added on the same edge or in the same space;
- the same part moved differently;
- different whole-model transforms;
- a **collision**: two edits that are each fine but pass surfaces through each other, or fold faces over, when combined.

**What does not conflict.** Edits to different vertices compose, even adjacent ones. So do the same change made on both sides, and a unit re-export on one side with local edits on the other: you get the edits, in the new units.

### Review a merge in the browser

```bash
polymerge view examples/plate/base.stl examples/plate/ours.stl examples/plate/theirs.stl
```

This is the review in the GIF at the top. The merged model is coloured by who shaped each face:
- blue: from ours;
- purple: from theirs;
- teal: the same change on both sides;
- grey: untouched;
- **orange: unresolved conflict**.

To resolve:
1. Click an orange region in 3D, or its card. Hover **Ours / Theirs / Base** to preview that version in place.
2. Click a button, or press `1` / `2` / `3`, to choose. `0` undoes the choice, and `n` / `p` step between conflicts.
3. Download the result (STL/OBJ), or copy the equivalent `polymerge merge … --pick …` command.

A warning appears if your choices combine into a collision.

`polymerge demo` opens built-in examples in the review. The merge examples are `boss-height`, `thin-wall`, `parts`, `mixed-choices` and `clean`, e.g. `polymerge demo thin-wall`. Diff examples open the same way: `polymerge demo moved-part`.

### Use it with git

```bash
polymerge git-setup      # prints the lines below
```

```bash
# .gitattributes
*.stl  diff=polymerge merge=polymerge
*.obj  diff=polymerge merge=polymerge
*.gltf diff=polymerge
*.glb  diff=polymerge

git config --global diff.polymerge.command "polymerge git-diff"
git config --global difftool.polymerge.cmd 'polymerge view "$LOCAL" "$REMOTE" --name "$MERGED"'
git config --global merge.polymerge.driver "polymerge git-merge %O %A %B %P"
```

Then:

```bash
git diff -- part.stl                              # structural report instead of "Binary files differ"
git log -p --ext-diff -- part.stl                 # history
git difftool -y -t polymerge HEAD~1 -- part.stl   # visual diff in the browser
git merge feature                                 # STL/OBJ merged three-way; a real conflict marks the file as conflicted
polymerge review part.stl                         # see the conflicts in the browser, pick by clicking
polymerge resolve part.stl --pick 0=theirs && git add part.stl
```

### Use it as a library

The engine is a separate package, `polymerge-core`. It runs in Node and in the browser.

```js
import { readFile, writeFile } from 'node:fs/promises';
import { loadMesh, diffMeshes, mergeMeshes, resolveMerge, writeStl } from 'polymerge-core';

const load = async (file) => loadMesh(await readFile(file), { fileName: file });
const [base, ours, theirs] = await Promise.all(['base.stl', 'ours.stl', 'theirs.stl'].map(load));

const diff = diffMeshes(base, ours);
console.log(diff.tierName, diff.stats.vertices); // Tier 1 · index/ID (direct lineage) { unchanged: 152, moved: 10, … }

const merge = mergeMeshes(base, ours, theirs);
for (const c of merge.conflicts) console.log(`#${c.id} ${c.message}`);
const resolved = resolveMerge(merge, { 0: 'theirs' });
await writeFile('merged.stl', writeStl(resolved.merged));
```

The engine logs every decision to the console (`[polymerge] …`). Pass `logger: { info() {}, warn() {} }` in the options to silence it. The types are in [`packages/core/src/types.ts`](packages/core/src/types.ts).

## Command reference

```
polymerge diff <base> <target> [--json out.json|-] [--force-tier 1|2|3] [--exit-code] [--top N] [-q]
polymerge view <base> <target> [--port N] [--no-open]
polymerge view <base> <ours> <theirs>            merge review: see conflicts, resolve by clicking
polymerge merge <base> <ours> <theirs> [-o out.stl|obj] [--resolve ours|theirs|base] [--pick id=side]
                [--report x.json] [--no-collision-check]
polymerge review <path>                          merge review of a conflicted git merge
polymerge resolve <path> --pick <id>=<side>      finish a conflicted git merge of a model
polymerge demo [example]                         the viewer on a built-in example
polymerge info <file>                            the normalised mesh summary
polymerge git-diff | git-merge | git-setup       git drivers, and the config to use them
```

`polymerge --help` lists every option.

## How it works

1. **Normalise.** STL, OBJ and glTF/GLB are loaded with the three.js loaders and converted into one mesh form:
   - vertices are welded;
   - glTF node transforms are baked in.

   The same geometry therefore gives the same mesh in any format.
2. **Correspond, in tiers.** The first tier that clears its quality threshold wins, and every attempt is logged.

   | Tier | Strategy | Handles |
   |---|---|---|
   | 1 | Vertex order or embedded IDs, validated by face agreement | Direct edits: moved vertices, appended or trimmed geometry |
   | 2 | Geometric seeds + propagation along the mesh (inspired by MeshGit) | Re-ordered files, local topology edits, holes, new patches |
   | 3 | ICP alignment (rigid or uniform scale) + nearest-surface mapping | Whole-model moves and rotations, unit mismatch, re-meshing |

   After that, parts that moved rigidly on their own are re-registered, so they read as *moved*. A whole-model motion is reported once, e.g. as a unit conversion, instead of every vertex moving.
3. **Classify.** Every vertex becomes unchanged, moved, added or removed, and every face unchanged, modified, added or removed.
4. **Merge.** Each side is diffed against the base and split into frames (whole-model and per-part transforms) and local edits. Frames and edits are merged separately, then the result is checked for combined damage (collisions). Details and rationale: [docs/merge-design.md](docs/merge-design.md).

## What v1 does and doesn't handle

**Handles**
- **Formats.**
  - Input: STL (ASCII and binary), OBJ, GLB, and `.gltf` with embedded buffers.
  - Output for merges: STL and OBJ (OBJ keeps groups).
- **Diff.**
  - Direct vertex edits, re-ordered files, and local topology edits (holes, new patches, re-triangulated areas).
  - Whole-model moves, rotations and unit conversions (mm, cm, m, in, ft).
  - Re-meshed models, via surface mapping.
  - Parts moved on their own.
- **Merge.**
  - Independent edits are combined, including frame composition (a unit re-export on one side plus edits on the other).
  - Conflicts are detected per region and resolved per region.
  - Collisions are detected: combined edits that make surfaces cross or fold.
  - git diff and merge drivers.
- **Scale.** Tested up to about 100k vertices:
  - a diff takes about 0.3 s (Tier 1) to 2.5 s (Tier 3);
  - a 100k-vertex merge takes about 1.2 s, of which the collision check is about 25%.

**Doesn't handle (yet), by design or by scope.** These are deliberate limits, not surprises.
- **The collision check detects damage, not design judgement** (design doc §4.1). It does not flag:
  - surfaces that only touch or overlap in the same plane;
  - near misses: clearances, minimum wall thickness, tolerances;
  - anything else that needs design intent.

  A merge can be free of collisions and still be wrong for your part. Review it.
- **Re-meshed sides can't be merged vertex by vertex.** If one side re-tessellated the model, the merge reports a whole-model `lineage` conflict: you pick one side's whole mesh. Transferring edits between tessellations is future work.
- **A side that splits a part and moves half of it** is seen as local moves, not a part motion. The other side's edits on that half then conflict.
- **Materials, UVs and normals are not merged**, only geometry and groups. Textures are ignored.
- **No glTF/GLB output.** Merges write STL or OBJ.
- **Not supported on input:**
  - `.gltf` files with external `.bin`/image files;
  - Draco- or meshopt-compressed glTF;
  - glTF scenes other than the default one;
  - OBJ objects that contain line (`l`) elements (they are skipped with a warning).
- **Ambiguous geometry:**
  - A part deleted in one place with an *identical* copy added elsewhere reads as a move.
  - Symmetric shapes aligned by Tier 3 report the least-motion equivalent.
  - A regular lattice shifted by exactly one period can be mis-matched.
  - A region dragged far from its connected neighbours is followed only within about 3 edge lengths.
- **Viewer:**
  - The camera assumes Y-up, so Z-up CAD/print models open side-on; orbit to fix it.
  - The merge review can't write the result back into your repository. It downloads the file or gives you the `polymerge resolve` command.

The full list of known limits and next steps is kept in [DEVLOG.md](DEVLOG.md).

## Development

```bash
npm install
npm run build          # core → CLI → web viewer
npm test               # unit, fixture and merge tests, then the perf tests on their own
npm run e2e            # headless-browser viewer, CLI → browser, worker, merge review, real git, packed npm install
npm run verify         # everything CI runs
npm run dev            # viewer dev server with the built-in examples
```

```
packages/core   polymerge-core — parsers, tiered diff engine, three-way merge, writers (Node + browser)
packages/cli    polymerge — the command line, with the web viewer bundled at publish time
apps/web        the Vite + three.js viewer
fixtures/       known-answer model pairs and their generator
examples/       the three-way merge example used in this README
docs/           design notes (three-way merge semantics) and README images
scripts/        end-to-end checks (CLI → browser, merge review, git, packed install) and image capture
```

CI runs `npm run verify` on every push. One of its checks, `scripts/e2e-pack.mjs`, packs both npm packages, installs them into an empty project and uses them from there: the CLI, the library example above, and the bundled viewer in a real browser.

### Releasing

Publishing is done by `.github/workflows/release.yml` when a version tag is pushed. It needs a repository secret `NPM_TOKEN` that can publish `polymerge` and `polymerge-core`.

1. Bump the version in `packages/core/package.json` and `packages/cli/package.json`, and set the CLI's `polymerge-core` dependency to the same version.
2. Commit, then `git tag v0.1.0 && git push origin v0.1.0`.

The workflow runs the full `npm run verify`, then publishes `polymerge-core` followed by `polymerge`, with npm provenance.

The README images are regenerated with `node scripts/readme-images.mjs`.

## License

[MIT](LICENSE) © Joshua Hurley
