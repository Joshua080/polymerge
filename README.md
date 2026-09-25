# polymerge

**Structural diff for 3D models.** polymerge works out which vertex in version A became which vertex in version B, and shows the result in the browser: green for added, red for removed, yellow for moved or modified. It works across STL, OBJ and glTF/GLB, and plugs into `git diff` and `git difftool`.

It is not a surface-deviation heatmap. polymerge computes a real vertex-to-vertex correspondence, so you can click a vertex and read *base #29 → target #77, Δ (0, 0, 0.25)*. That correspondence is also the foundation for three-way merging later.

> Status: **v1 MVP**. The pipeline works end to end and is tested. Polish and merge support come next; see [DEVLOG.md](DEVLOG.md).

## Quick start

```bash
npm install
npm run build          # core → cli → web viewer
npm test               # unit + known-answer fixture suite
npm run e2e            # headless-browser smoke tests (viewer + CLI → browser)

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
   | 3 | ICP rigid alignment + nearest-surface mapping | Whole-model moves or rotations, re-meshing, lost index lineage |

3. **Classify.** Every vertex is marked *unchanged / moved / added / removed*, and every face *unchanged / modified / added / removed*. The CLI reports these and the viewer colours them.

## CLI

```
polymerge diff <base> <target> [--json out.json|-] [--force-tier 1|2|3] [--exit-code] [--top N]
polymerge view <base> <target> [--port N] [--no-open]
polymerge info <file>
polymerge git-diff …          # git external diff driver
polymerge git-setup           # prints the git config below
```

## Git integration

```bash
# .gitattributes
*.stl  diff=polymerge
*.obj  diff=polymerge
*.gltf diff=polymerge
*.glb  diff=polymerge

git config diff.polymerge.command "polymerge git-diff"
git config difftool.polymerge.cmd 'polymerge view "$LOCAL" "$REMOTE" --name "$MERGED"'

git diff -- part.stl                              # structural report in the terminal
git log -p --ext-diff -- part.stl                 # history
git difftool -y -t polymerge HEAD~1 -- part.stl   # visual diff in the browser
```

## Repository layout

```
packages/core   @polymerge/core: types, parsers, tiered diff engine (runs in Node and the browser)
packages/cli    @polymerge/cli: the `polymerge` command
apps/web        @polymerge/web: Vite + Three.js viewer
fixtures/       generator for known-answer model pairs, plus the end-to-end suite
scripts/        CLI → browser end-to-end check
```

## License

[MIT](LICENSE)
