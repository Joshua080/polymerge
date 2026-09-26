# polymerge

[![CI](https://github.com/Joshua080/polymerge/actions/workflows/ci.yml/badge.svg)](https://github.com/Joshua080/polymerge/actions/workflows/ci.yml)

**Structural diff for 3D models.** polymerge works out which vertex in version A became which vertex in version B, and shows the result in the browser: green for added, red for removed, yellow for moved or modified. It works across STL, OBJ and glTF/GLB, and plugs into `git diff` and `git difftool`.

It is not a surface-deviation heatmap. polymerge computes a real vertex-to-vertex correspondence, so you can click a vertex and read *base #29 → target #77, Δ (0, 0, 0.25)*. That correspondence is also the foundation for three-way merging later.

> Status: diff (v1) and three-way merge (v1) work end to end and are tested; see [DEVLOG.md](DEVLOG.md).

## Quick start

```bash
npm install
npm run build          # core → cli → web viewer
npm test               # unit + known-answer fixture suite, then the perf tests on their own
npm run e2e            # end-to-end: headless-browser viewer, CLI → browser, worker, real git
npm run verify         # everything CI runs: typecheck, tests, build, e2e

# Diff two models in the terminal
node packages/cli/dist/cli.js diff fixtures/cases/mixed-topology-edit/base.obj fixtures/cases/mixed-topology-edit/target.obj

# ...or open the interactive 3D diff
node packages/cli/dist/cli.js view old.stl new.obj

# Viewer dev server with the built-in examples
npm run dev
```

To get a global `polymerge` command, run `npm link -w @polymerge/cli`.

## How it works

1. **Normalise.** Each format is loaded with the stock three.js loader (STLLoader, OBJLoader, GLTFLoader) and converted into one `IMesh`:
   - vertices are welded on exact float32 equality and numbered in first-appearance order;
   - glTF node transforms are baked into the vertex positions;
   - groups, materials and optional `_VERTEX_ID` ids are kept.

   The same geometry therefore gives the same `IMesh` whether it was saved as STL, OBJ or GLB.
2. **Correspond, in tiers.** Each tier is scored, and the first one that clears its threshold is used. Every attempt, and the tier finally accepted, is logged to the console.

   | Tier | Strategy | Handles |
   |---|---|---|
   | 1 | Vertex index/order or internal IDs, validated by face agreement | Direct edits: moved vertices, appended or trimmed geometry |
   | 2 | Greedy geometric + adjacency propagation (inspired by MeshGit) | Re-ordered files, local topology edits, holes, new patches |
   | 3 | ICP alignment (rigid, or uniform scale) + nearest-surface mapping | Whole-model moves or rotations, unit mismatch (in ↔ mm ↔ cm ↔ m ↔ ft), re-meshing, lost index lineage |

   After the accepted tier, parts (connected components) that moved rigidly on their own are re-matched by registration, so they read as *moved* instead of removed + added. A whole-model motion, such as the same file re-exported in millimetres, is reported as one global transform (with the unit conversion named) instead of every vertex "moving".
3. **Classify.** Every vertex is marked *unchanged / moved / added / removed*, and every face *unchanged / modified / added / removed*. The CLI reports these and the viewer colours them.

## Three-way merge

```bash
polymerge merge base.stl ours.stl theirs.stl -o merged.stl       # exit 1 while conflicts remain
polymerge merge base.stl ours.stl theirs.stl -o merged.stl --pick 0=theirs
```

Every change that does not conflict is applied. This includes composing frames: if ours was re-exported in mm and theirs moved a vertex, the result is theirs' edit, in mm.

Real conflicts are reported as regions:
- the same vertex moved differently;
- a vertex deleted on one side while the other side builds on it;
- different geometry added on the same edge or in the same space;
- the same part moved differently.

Those regions **keep the base geometry until you choose** `ours`, `theirs` or `base` for them; the tool never guesses. The rules are in [docs/merge-design.md](docs/merge-design.md).

**Combined edits are checked too.** Two edits can each be fine on their own side and still break the model together. For example, both sides push the two faces of a thin wall towards each other, or move two parts into the same space. The merge applies everything that does not conflict and inspects the result. When surfaces pass through each other, or faces fold over or collapse, where neither base, ours nor theirs has that damage, it reports a **`collision` conflict** covering both edits. Picking resolutions per region can also produce such damage (top from ours, bottom from theirs). That combination is reported as a **warning**, and the git merge driver then stops rather than committing it.

What the check deliberately does **not** judge (v1 limits):
- surfaces that only touch or overlap in the same plane;
- near misses, such as clearances or minimum wall thickness;
- design intent in general.

`--no-collision-check` (API: `detectCollisions: false`) turns the check off.

## CLI

```
polymerge diff <base> <target> [--json out.json|-] [--force-tier 1|2|3] [--exit-code] [--top N]
polymerge view <base> <target> [--port N] [--no-open]
polymerge merge <base> <ours> <theirs> [-o out.stl|obj] [--resolve ours|theirs|base] [--pick id=side] [--report x.json] [--no-collision-check]
polymerge resolve <path> --pick <id>=<side>   # finish a conflicted git merge of a model
polymerge info <file>
polymerge git-diff …          # git external diff driver
polymerge git-merge …         # git merge driver
polymerge git-setup           # prints the git config below
```

## Git integration

```bash
# .gitattributes
*.stl  diff=polymerge merge=polymerge
*.obj  diff=polymerge merge=polymerge
*.gltf diff=polymerge
*.glb  diff=polymerge

git config diff.polymerge.command "polymerge git-diff"
git config difftool.polymerge.cmd 'polymerge view "$LOCAL" "$REMOTE" --name "$MERGED"'
git config merge.polymerge.driver "polymerge git-merge %O %A %B %P"

git diff -- part.stl                              # structural report in the terminal
git log -p --ext-diff -- part.stl                 # history
git difftool -y -t polymerge HEAD~1 -- part.stl   # visual diff in the browser
git merge feature                                 # three-way model merge; conflicts → file marked UU
polymerge resolve part.stl --pick 0=theirs && git add part.stl
```

## Repository layout

```
packages/core   @polymerge/core: types, parsers, tiered diff engine, three-way merge, writers (Node + browser)
packages/cli    @polymerge/cli: the `polymerge` command
apps/web        @polymerge/web: Vite + Three.js viewer
fixtures/       generator for known-answer model pairs, plus the end-to-end suite
docs/           design notes (three-way merge semantics)
scripts/        CLI → browser and real-git end-to-end checks
```

## License

[MIT](LICENSE)
