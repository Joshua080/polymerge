# @polymerge/core

The engine behind [polymerge](https://github.com/Joshua080/polymerge): loading and normalising 3D models (STL, OBJ, glTF/GLB), a tiered vertex-correspondence **diff**, and a region-based **three-way merge** with collision detection. It runs in Node and in the browser.

For the command line and the browser viewer, install [`polymerge`](https://www.npmjs.com/package/polymerge) instead.

```bash
npm install @polymerge/core
```

```js
import { readFile, writeFile } from 'node:fs/promises';
import { loadMesh, diffMeshes, mergeMeshes, resolveMerge, writeStl } from '@polymerge/core';

const load = async (file) => loadMesh(await readFile(file), { fileName: file });
const [base, ours, theirs] = await Promise.all(['base.stl', 'ours.stl', 'theirs.stl'].map(load));

const diff = diffMeshes(base, ours);
console.log(diff.tierName, diff.stats.vertices); // Tier 1 · index/ID (direct lineage) { unchanged: 152, moved: 10, … }

const merge = mergeMeshes(base, ours, theirs);
for (const c of merge.conflicts) console.log(`#${c.id} ${c.message}`);
const resolved = resolveMerge(merge, { 0: 'theirs' });
await writeFile('merged.stl', writeStl(resolved.merged));
```

- `loadMesh(bytes, { fileName? })` returns a welded, normalised `IMesh`. The format is detected from the bytes and the name.
- `diffMeshes(base, target, options?)` returns an `IDiffResult` with:
  - the accepted tier and every attempt;
  - `baseToTarget` / `targetToBase` correspondences, and per-vertex and per-face status;
  - the global alignment (including unit conversions) and moved parts.
- `mergeMeshes(base, ours, theirs, options?)` returns an `IMergeResult` with:
  - the merged mesh;
  - the conflict regions (unresolved ones keep the base geometry), with provenance and statistics.

  `resolveMerge(result, { id: 'ours' | 'theirs' | 'base' })` re-materialises it with your choices.
- `writeStl` / `writeObj` serialise a mesh.

The engine logs its decisions to the console. Pass `logger: { info() {}, warn() {} }` to silence it.

The types are documented in the source (`dist/types.d.ts`). The merge rules and the v1 limits are in the [README](https://github.com/Joshua080/polymerge#what-v1-does-and-doesnt-handle) and [merge design notes](https://github.com/Joshua080/polymerge/blob/main/docs/merge-design.md).

MIT © Joshua Hurley
