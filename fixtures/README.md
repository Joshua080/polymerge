# polymerge fixtures

Small model pairs with known changes, built so that the expected result can be worked out exactly from how each file was made. They check the parsers (the normalisation contract in `packages/core/src/types.ts`) and the diff engine (which tier it picks, vertex and face statuses, alignment).

```bash
npm run fixtures           # regenerate cases/** and manifest.json (same bytes every run)
npx vitest run fixtures    # selfcheck.test.ts + e2e.test.ts
```

- `generate.ts`: the command-line entry point (`--out <dir>` writes the files to another directory).
- `lib/`: the code that builds the fixtures:
  - `builders` makes the shapes (grid, box, polycube, the asymmetric L-bracket, cylinder, subdivided box).
  - `kmesh` gives every vertex a logical key and provides edits such as move, remove, append, reorder faces and rotate corners.
  - `documents` holds in-memory models of the STL, OBJ and glTF files, plus the triangle stream each one yields.
  - `writers` writes ASCII STL, binary STL, OBJ, GLB, and `.gltf` with a base64 `data:` buffer.
  - `reference` re-implements welding and the status rules.
  - `cases` defines the cases; `math` and `prng` hold helpers.
- `selfcheck.test.ts` does not use any polymerge code. It re-reads every file with the stock three.js loaders, welds the result with its own code and compares it with the manifest. It then works out every exact count again from the loaded data and `mustMatch`, using the contract's status rules. It also checks the size limits and that re-running the generator gives the same bytes.
- `e2e.test.ts` runs `loadMesh` and `diffMeshes` on every case. It checks the mesh sizes, the tier, the counts, `mustMatch`, the alignment and the structural invariants of `IDiffResult`, and that the log names the resolved tier.

## How the expectations are derived

Each vertex has a logical key, such as `g:3,4` for grid vertex (3, 4). The generator follows the contract to produce each file's triangle stream: file order for STL and OBJ; for glTF, a depth-first walk of the nodes with transforms baked in using three.js arithmetic. It then welds the stream on exact float32 values in first-appearance order and drops degenerate triangles. Matching keys between base and target gives the true correspondence, and the contract's status rules give the counts. Most cases also compare these results with numbers worked out by hand (for example, 30 faces touch the raised block in `grid-bump`). If the two ever disagree, generation fails.

Coordinates are dyadic, or are rounded to float32 on purpose. Text formats use the shortest decimal string that parses back to the same float32 value.

- **Tier 1 and 2 cases** have exact counts, and `mustMatch` lists every matched pair.
- **Tier 3 cases** use ranges.
- The alignment `tolerance` applies three ways: the translation error in model units, the angle error in degrees, and the angle between the expected and actual axes in degrees.

## Cases

| id | base → target | change | tiers | V/F base → target | key expectations |
|---|---|---|---|---|---|
| identical-cube | STL bin → STL bin | none (header only) | 1 | 8/12 → 8/12 | all unchanged |
| cube-moved-corner | STL ascii → STL bin | corner (1,0,1) +0.5 z | 1 | 8/12 → 8/12 | V 7 unch / 1 moved; F 8 unch / 4 mod |
| grid-bump | OBJ → OBJ | 3×3 vertex block +0.5 z | 1 | 121/200 → 121/200 | V 112/9 moved; F 170/30 mod |
| cross-format-identical | STL bin → OBJ | none (L-bracket) | 1 | 46/88 → 46/88 | all unchanged |
| cross-format-identical-obj-glb | OBJ → GLB | vertex buffer shuffled | 1 | 34/64 → 34/64 | all unchanged |
| gltf-embedded-vs-glb | .gltf (data URI) → .glb | none (node TRS) | 1 | 26/48 → 26/48 | all unchanged |
| glb-vertex-ids | GLB → GLB | faces + buffer shuffled, `_VERTEX_ID`, 1 vertex +0.25 z | 1 (ID) | 36/50 → 36/50 | 1 moved; 6 faces mod |
| gltf-multi-node | GLB → GLB | node B translation +1 x (shared mesh) | 1 | 16/24 → 16/24 | 8 unch / 8 moved; 12 / 12 mod |
| degenerate-triangles | STL bin → STL ascii | +2 degenerate triangles | 1 | 8/12 → 8/12 | all unchanged (14 source tris) |
| gltf-node-hierarchy | OBJ → GLB | nested T·R(180°)·S(2) · T nodes | 1 | 46/88 → 46/88 | all unchanged |
| multi-part-obj-glb | OBJ (o/g/usemtl) → GLB (2 nodes, 3 prims) | none | 1 | 17/20 → 17/20 | all unchanged |
| added-geometry | STL bin → STL bin | open box appended | 1, 2 | 81/128 → 85/138 | +4 V, +10 F |
| removed-patch | OBJ → STL ascii | 3×3-quad hole mid-stream | 1, 2 | 121/200 → 117/182 | −4 V, −18 F |
| shuffled-faces | OBJ → OBJ | faces/corners/v shuffled, 1 vertex +0.25 z | 2 | 81/128 → 81/128 | 1 moved; 6 faces mod |
| mixed-topology-edit | OBJ → OBJ | shuffle + 4 moved + hole + flap | 2 | 169/288 → 169/276 | V 161/4/+4/−4; F 254/16/+6/−18 |
| rigid-transform | OBJ → GLB | 30° about (1,2,2) + t, shuffled | 3 | 46/88 → 46/88 | alignment ±0.01; ≥ 42 unch; 0 added/removed |
| remesh | STL bin → OBJ | cylinder 24 → 32 segments | 3 | 50/96 → 66/128 | added/removed ≤ 2 |
| remesh-box | OBJ → GLB | box faces subdivided at 1/2 → 1/3 | 3 | 210/416 → 470/936 | added/removed ≤ 2 |

`manifest.json` gives the full reasoning behind each case in its `description` field.
