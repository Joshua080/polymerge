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
| D8 | Nothing is pushed to a remote this session. | Owner's instruction: local verification first. |

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
