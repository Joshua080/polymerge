# polymerge — DEVLOG

A living log of milestones, architectural decisions, what works, what is stubbed, known bugs and next steps. Newest session at the top; entries within a session are in order.

---

## Session 1 — 2026-09-25 — v1 MVP: end-to-end pipeline

### Milestone 0 — Plan & contract (orchestrator)

**Architecture**

```
packages/core   @polymerge/core  isomorphic (Node + browser), no fs/DOM
  src/types.ts        shared type contract (IMesh, IVertex, IDiffResult, ...) — orchestrator-owned
  src/mesh.ts         createMesh / getVertex / getFace / describeVertexChange helpers
  src/parsers/        STL / OBJ / glTF+GLB → IMesh via three.js loaders + welding
  src/diff/           tiered correspondence engine (Tier 1 → 2 → 3) + JSON serialisation
packages/cli    @polymerge/cli   `polymerge diff | view | info | git-diff`
apps/web        @polymerge/web   Vite + Three.js viewer (OrbitControls, strict colour legend)
fixtures/                        generator + known-answer model pairs + e2e tests
```

**Decisions**

| # | Decision | Why |
|---|----------|-----|
| D1 | One normalised `IMesh`: welded float64 vertex pool + `Uint32Array` triangles + groups/materials/metadata. | The diff engine never branches on source format. |
| D2 | Welding = exact float32 equality, indices in **first-appearance order of the triangle stream**. | STL has no shared vertices and three's OBJLoader de-indexes, so real index identity is gone. A deterministic weld order restores a stable "index" that is identical across STL/OBJ/GLB for the same face order, which is what makes Tier 1 viable. |
| D3 | Diff results live in **target space**; `alignment` (base→target rigid transform) is the identity for Tiers 1/2 and the ICP solution for Tier 3. | One coordinate frame for the viewer and for status thresholds. |
| D4 | Bulk per-vertex/per-face data in typed arrays; `IVertex`/`IFace`/`IVertexChange` are object *views* for UI/reporting. | Scales to 100k+ vertex meshes without per-vertex objects. |
| D5 | Canonical colours are exported from core (`DIFF_COLORS`): added `#22c55e`, removed `#ef4444`, moved/modified `#facc15`, unchanged `#9ca3af`. | Single source of truth for the viewer, CLI and docs. |
| D6 | The engine always logs each tier attempt and the accepted tier (default sink `console`). | Hard requirement: every diff states which tier fired. |
| D7 | The viewer consumes core **from source** through a Vite alias; the CLI consumes the built `dist`. | No build step needed for web dev; a real `bin` for the CLI. |
| D8 | Nothing is pushed to a remote this session. | Owner's instruction: local verification first. Lifted once verification passed (Milestone 7). |

**Environment findings**
- three@0.186.1 loaders run under Node 22: STL ✔, OBJ ✔, GLB ✔ (custom attribute `_VERTEX_ID` surfaces as `_vertex_id`).
- JSON `.gltf` with data-URI buffers fails under Node (`ProgressEvent is not defined`, via FileLoader/fetch); it needs a workaround in the parser.

**Subagent split (run in parallel, disjoint file ownership)**
1. Parsers & Normalisers → `packages/core/src/parsers/**`, `packages/core/test/parsers/**`
2. Core Diff Engine → `packages/core/src/diff/**`, `packages/core/test/diff/**`
3. Front-end Visualiser → `apps/web/**`
4. Test Fixtures → `fixtures/**` (generator, cases, manifest, e2e tests)
Orchestrator: types, mesh helpers, CLI, root config, docs, integration.

### Milestone 1 — CLI + git integration (orchestrator, in parallel with the agents)

`packages/cli` (`polymerge` bin, built with tsc against core's `dist`):

- `polymerge diff <base> <target>`: colour report (tier attempts, vertex/face counts, displacement, alignment, largest vertex moves). `--json <file|->` writes the serialised `IDiffResult`, `--force-tier`, `--move-eps`, `--surface-tol`, `--exit-code`. Engine logs go to **stderr**, so stdout stays pipeable.
- `polymerge view <base> <target>`: tiny `node:http` server that serves `apps/web/dist` and the two models at `/models/{base,target}/<name>`. It opens `/?base=…&target=…` in the browser. Model bytes are read up front so `git difftool` temp files may vanish.
- `polymerge info <file>`: normalised mesh summary (welded vs loader counts, groups, materials, warnings).
- `polymerge git-diff`: **GIT_EXTERNAL_DIFF driver** (`diff.polymerge.command`). Handles new/deleted files (`/dev/null`) and renames (9-arg form). It uses the repo path for format detection because git's temp files may be named arbitrarily. It always exits 0, since git aborts on non-zero, and falls back to "Binary files … differ" when it can't parse.
- `polymerge git-setup`: prints the `.gitattributes` + `git config` snippet (it does not modify any config itself).

### Milestone 2 — Parsers & normalisers (agent 1) ✅

- `packages/core/src/parsers/`: `detect.ts`, `bytes.ts`, `weld.ts` (`buildWeldedMesh`: format-agnostic triangle soup → `IMesh`), `stl.ts`, `obj.ts`, `gltf.ts`, `gltf-container.ts`, `three-mesh.ts`, `index.ts` (`detectFormat`, `loadMesh`).
- **Exact weld** keys on the float32 bit patterns (-0 → +0) in a custom open-addressing hash, with no string keys. A second renumbering pass after degenerate removal keeps indices in first-appearance order among *kept* triangles. A 1M-triangle STL welds in about 0.3 s.
- **Epsilon weld** uses a grid with 2ε cells and a 2×2×2 probe. Each corner merges into the earliest vertex within ε, measured to that vertex's first position. This is not transitive: in a chain A–B–C, C may stay separate.
- **glTF**: every `.gltf`/`.glb` is repacked into one in-memory GLB before GLTFLoader sees it. That fixes data-URI `.gltf` under Node without touching globals.
  - External URIs throw `MeshLoadError`. Images, textures and samplers are stripped, with one warning.
  - If Draco or meshopt is *required* the loader throws. If either is optional, the fallback data is used.
  - Skinned meshes, morph default weights and instancing are baked. Materials are de-duplicated per glTF material index.
- **STL**: binary facet colours become `materials` + `faceMaterials`. Truncated or undersized files, and binary files whose header starts with "solid", are pre-validated before three sees them.
- 85 tests: exact weld order, cross-format identity (ASCII/binary STL, OBJ, GLB, .gltf give identical arrays), transform baking, ids, degenerates, sniffing, errors and `weldEpsilon`.

### Milestone 3 — Core diff engine (agent 2) ✅

`packages/core/src/diff/`: `engine.ts` (tier chain + mandatory logging), `tier1.ts`, `tier2.ts`, `tier3.ts`, `classify.ts`, `adjacency.ts` (CSR), `faceset.ts`, `spatial.ts` (kd-tree, triangle BVH), `linalg.ts` (Horn quaternion + 4×4 Jacobi), `heap.ts`, `prng.ts`, `serialize.ts`.

| Tier | Score | Threshold | Notes |
|---|---|---|---|
| 1 | `min(faceAgreement, matchedFraction)`, both over the **smaller** mesh | 0.95 | See T1 below |
| 2 | `coverage × edgeConsistency`, where `coverage = (matched − slid) / (min(nB,nT) + onSurfaceUnmatched)` | 0.60 | See T2 below |
| 3 | inlier fraction (within `surfaceTolerance`) | terminal | See T3 below |

- **T1 — index/ID.**
  - ID mode runs when both sides have ≥ 50% `vertexIds`; otherwise index mode `i ↔ i`.
  - *Orphan rule:* a pair is un-matched (removed + added) when the vertex has faces but none of them is preserved.
  - Result: any move, appended geometry or end-trim scores 1; shuffled or unrelated meshes score about 0.
- **T2 — MeshGit-inspired.**
  - Seeds are *unambiguous* mutual nearest neighbours within `moveEpsilon`.
  - Growth is greedy from a min-heap, with cost `g/√a + 2(1 − J)` and cutoff 3.
    - a = number of agreeing matched neighbours.
    - J = Jaccard agreement of the two matched neighbourhoods.
    - g = residual after following the neighbours' mean displacement, over the local edge length.
  - A *face-support gate* stops growth across a foreign tessellation.
  - "slid" (a match that moved along the old surface) and "on-surface unmatched" are evidence of retessellation. That is what now pushes `remesh` down to Tier 3: it scores 0.248 there, versus 0.97–1.0 on real topology edits.
- **T3 — ICP.**
  - Initial guesses: identity, centroid, and det=+1 PCA frames (all 24 axis permutations when two moments are within 10%).
  - A trimmed point-to-point coarse stage, then Horn refinement and a point-to-plane polish. The least-motion fit within 1.25× of the best residual wins, so an unmoved remesh reports the identity.
  - Mapping uses exact point-to-triangle distance (BVH) plus the nearest vertex (kd-tree).
- **Timings (100k vertices, Node):** Tier 1 ≈ 0.2 s; chain to Tier 2 ≈ 0.75 s; chain to Tier 3 ≈ 1.85 s.
- **Tests:** 55.
- **Contract clarifications** applied to `types.ts` on the agent's recommendation:
  - Tier 3 `baseToTarget` semantics;
  - `stats` matched counts are target-side;
  - `rmsError` may be > 0 for Tier 3 even when the fit is the identity.

### Milestone 4 — Web visualiser (agent 3) ✅

- `apps/web/`: `src/app.ts` (controller), `scene/viewer.ts`, `scene/layers.ts`, `panels.ts`, `sources.ts`, `hook.ts`, `dev/mock.ts`, `style.css`, and a `vite.config.ts` fixtures plugin. The plugin serves `/fixtures/*` in dev and preview with a traversal guard, and copies the fixtures into `dist/` on build.
- **Rendering:** the target is drawn non-indexed with per-face `DIFF_COLORS`. Removed base faces are drawn in red after being moved into target space by `alignment`.
- **Layer toggles:** base ghost, unchanged faces, vertex markers, displacement vectors, wireframe.
- **Panels and inspection:**
  - The tier badge and attempt log, plus counts and alignment.
  - **Click-to-inspect** uses `describeVertexChange`: *base #i → target #j, from/to/Δ/distance*. There is also an inspector for looking up a vertex by index.
- **Loading:**
  - Drag-and-drop or file pickers.
  - An examples dropdown built from the fixture manifest.
  - URL parameters: `?base=&target=`, `?case=`, `?tier=`, `?mock=1`.
  - A "Download diff JSON" button.
- **Test hook:** `window.__POLYMERGE__` plus `body[data-state]`.
- **Smoke test:** `apps/web/e2e/smoke.mjs` uses Playwright and SwiftShader WebGL. It checks the hook, that the canvas is not blank, which diff hues are present, and click-to-inspect.

### Milestone 5 — Test fixtures (agent 4) ✅

- `fixtures/generate.ts` plus `fixtures/lib/`: builders, independent writers for STL (ASCII and binary), OBJ, GLB and data-URI .gltf, and a reference welder. The generator is deterministic and byte-stable.
- **18 cases**, 37 files, 154 KB. See `fixtures/README.md`. They cover:
  - Tier 1: identical, moved corner, grid bump, cross-format (STL↔OBJ, OBJ↔GLB, .gltf↔GLB), `_VERTEX_ID` with a shuffle, multi-node transforms, node hierarchy, multi-part OBJ↔GLB, degenerates, appended geometry.
  - Tier 2: removed patch, shuffled faces, mixed topology edit.
  - Tier 3: rigid 30° about (1,2,2) + translation; cylinder remesh 24→32 segments; box remesh.
- **Expectations** are derived by a reference model of the normalisation contract and cross-checked against hand-derived numbers.
- `selfcheck.test.ts` validates the files with the stock three.js loaders only, without any polymerge code. `e2e.test.ts` asserts sizes, tier, counts, `mustMatch` pairs, alignment, invariants, and that a log line names the tier.

### Milestone 6 — Integration & verification (orchestrator) ✅

| Check | Result |
|---|---|
| `npm run typecheck` (core, core tests + fixtures, cli, web) | clean |
| `npm test` (vitest) | **347 passed**, 73 skipped (all skips are per-case `runIf` gates, e.g. alignment checks only on rigid cases) |
| `npm run build` (core → cli → web) | OK (web bundle 750 kB: three.js, not yet code-split) |
| `node apps/web/e2e/smoke.mjs` (real core, headless Chromium + SwiftShader) | **18/18 cases pass**, including click-to-inspect |
| `node scripts/e2e-view.mjs` (`polymerge view` → local server → browser → real diff → render) | PASS, and the tier line appears in the *browser* console |
| git driver in a scratch repo (`diff=polymerge` + `diff.polymerge.command`) | `git diff part.obj` prints the structural report, e.g. Tier 2 · *base #29 → target #77 Δ(0,0,0.25)*; new-file path verified |

The integration fix went back to its owner: fixtures + parsers exposed `remesh` being accepted by Tier 2. The diagnosis was relayed to the diff agent, which added the retessellation evidence (slid / on-surface) to the Tier 2 score.

### Milestone 7 — Published to GitHub ✅

- Local verification passed from a fresh clone (`npm install && npm run verify`), and the owner then approved publishing.
- The work is now on **`main`** at `github.com/Joshua080/polymerge`. It was renamed from the session branch `claude/optimistic-franklin-u4oplc`, so the history is unchanged.
- The LICENSE copyright holder is Joshua Hurley.
- No PR yet. PRs start with the next feature branch, compared against `main`.

### State at end of session 1

**Fully operational**
- Load STL (ASCII/binary), OBJ, GLB and data-URI .gltf in Node and the browser → a single welded `IMesh`.
- Tiered correspondence 1 → 2 → 3, with every attempt and the accepted tier logged to the console.
- CLI: `diff` (report / JSON / exit code), `view`, `info`, `git-diff` (external diff driver), `git-setup`.
- Browser viewer with strict colour coding, orbit/zoom, layers and vertex-level inspection.
- Deterministic known-answer fixtures, plus unit, e2e and browser smoke suites.

**Stubbed / mocked / not yet built**
- **Three-way merge** is not started. The architecture is ready for it: one correspondence per side against a common base.
- `?mock=1` in the viewer is a dev-only mock. The real path never uses it.
- The diff runs on the browser main thread; there is no Web Worker yet.
- `.gltf` with external `.bin`/image URIs is not supported (throws `MeshLoadError`). Draco and meshopt are not supported. Textures are ignored.

**Known issues / limitations**
- A deletion near the *end* of the face stream can still pass Tier 1, with the shifted tail reported as removed + added.
- Tier 2 cannot seed a component that was rigidly moved *on its own*; it shows as removed + added.
- A regular lattice shifted by exactly one period mis-seeds.
- Tier 3 is rigid only: no scale (mm↔inch) and no per-part motion. Symmetric shapes report their least-motion equivalent. Tier 3 correspondences can be many-to-one.
- The epsilon weld is not transitive.
- OBJLoader turns any object that contains an `l` line into lines, so that object's faces are skipped, with a warning.
- Only the default glTF scene is loaded.
- Viewer:
  - Removed faces that sit off the target surface are drawn over it; toggle the layer to see what is underneath.
  - Markers and vectors switch off by default above 1.5k / 5k elements.
  - The web bundle is not code-split.
- three.js prints its own console warnings on malformed files; they are not suppressed.

**Next steps (session 2)**
1. **Three-way merge MVP**:
   - diff(base→ours) and diff(base→theirs);
   - vertex-level conflict detection (the same base vertex moved differently, or edited on one side and deleted on the other);
   - an auto-merge of non-conflicting edits;
   - `merge.polymerge.driver` for git;
   - a conflict view in the viewer.
2. Move `diffMeshes` into a Web Worker, and add a side-by-side / slider compare mode.
3. Tier 2: per-component rigid seeding, via ICP on unmatched components, so separately moved parts stay "moved".
4. Tier 3: optional uniform scale (unit-mismatch detection).
5. CI (GitHub Actions running `npm run verify`), and npm publishing of `@polymerge/core` and `@polymerge/cli`.
6. Small contract follow-ups: promote `extras.invalidFacesDropped` to a metadata field, and decide whether to export `buildWeldedMesh` publicly.
