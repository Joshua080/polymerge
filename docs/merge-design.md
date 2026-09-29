# Three-way merge — design

Status: designed in session 2; `collision` (§4.1) was added in session 3. The implementation in `packages/core/src/merge/` follows this document. Materials, UVs and texture references have their own rules, in **[appearance-merge-design.md](appearance-merge-design.md)**: they are not geometry, and their conflicts are defined differently.

Given a common ancestor **O** (base) and two derived versions **A** (ours) and **B** (theirs), produce:

1. a merged mesh **M** in which every change that does not conflict is applied, and
2. a list of conflicts, each covering a region, that a person must resolve.

The tool never guesses. Until a person chooses, every conflict region stays exactly as it was in the base.

The hard part is deciding what a *conflict* is. Text merge (diff3) has a simple answer: two hunks conflict when they overlap or touch. Meshes need a different one. This document works it out from first principles.

---

## 1. Why text-merge rules do not transfer directly

| Text (diff3) | Mesh | Consequence |
|---|---|---|
| A line is a semantic unit; neighbouring lines usually belong to the same idea. | A vertex is a *sample* of a surface; neighbouring vertices are usually independent. | Adjacency must **not** mean conflict by itself. Otherwise two people sculpting near each other would conflict constantly. |
| Positions are not affected by coordinate frames. | A whole-model move, a unit conversion or a moved part changes every vertex coordinate without changing the design locally. | A naive per-vertex comparison would flag false conflicts everywhere (see §3). Changes must be separated into **frames** and **local residuals**. |
| Insertions are ordered in a sequence. | Additions are anchored to existing vertices/edges, or float freely in space. | "Both sides inserted at the same place" means *the same anchor edge* or *overlapping space*. |
| The result is always a valid text file. | The result must be a sensible mesh: faces referencing existing vertices, no dangling geometry. | Deleting geometry that the other side builds on is a conflict. |

## 2. What a change is

`diffMeshes(O, S)` gives, for each side S ∈ {A, B}, a vertex correspondence `m_S : V_O → V_S ∪ {⊥}` plus a global alignment `T_S` and part motions `G_S,c` (similarity transforms, see the diff engine). A base vertex v is **kept** on S when `m_S(v) ≠ ⊥`; otherwise it is **deleted**.

**Frames.** Every base vertex v lies in exactly one base component c(v). Its frame on side S is:

```
Φ_S(v) = T_S ∘ R_S,c(v)      where R_S,c = T_S⁻¹ ∘ G_S,c  (the part's motion relative to the global frame)
```

`R_S,c` is the identity when the part did not move on its own.

**Local residual.** A kept vertex has a local edit, expressed in the **base frame**:

```
δ_S(v) = Φ_S(v)⁻¹( p_S(m_S(v)) ) − p_O(v)
```

A vertex is *locally changed* on S when `|δ_S(v)| > ε`. Here ε is the diff's `moveEpsilon`, converted into base units.

**Faces.** A base face f = (a, b, c) is **kept** on S when all three corners are kept and `(m_S(a), m_S(b), m_S(c))` is a face of S; the comparison ignores corner order. Otherwise f is **deleted** on S.

**Additions.** Vertices of S that no base vertex maps to are **added vertices**. Faces of S that are not images of kept base faces are **added faces**. An added face's corners are either *anchors* (kept base vertices) or added vertices.

So each side is fully described by a set of **atomic edits** against the base:

| Edit | Meaning |
|---|---|
| `frame(c, R)` | part c moved rigidly by R (relative to the global frame) |
| `global(T)` | the whole model moved / was rescaled / re-exported in other units |
| `move(v, δ)` | base vertex v locally displaced by δ |
| `deleteVertex(v)` | base vertex v gone (and with it every face using it) |
| `deleteFace(f)` | base face f gone, its vertices may survive |
| `add(x)`, `addFace(…)` | new geometry, anchored to kept base vertices or floating |

## 3. Composition: frames first, residuals second

The merged position of a kept, non-conflicting base vertex is:

```
p_M(v) = Φ_M(v)( p_O(v) + δ_M(v) )
```

Frames and residuals are merged independently, each with the same three-way rule:

```
merge(x_A, x_B) = x_B            if x_A is "no change"
                  x_A            if x_B is "no change"
                  x_A            if x_A ≈ x_B              (convergent: both made the same change)
                  CONFLICT       otherwise
```

This is what makes the following cases merge cleanly, when naive per-vertex rules would turn them into false conflicts:

| Ours | Theirs | Naive per-vertex view | Frame + residual view |
|---|---|---|---|
| Re-exported in mm (×25.4) | Moved one vertex | every vertex moved on both sides → conflicts everywhere | `global(×25.4)` + `move(v, δ)` → theirs' edit, converted to mm |
| Moved a bolt (part) | Edited a vertex on that bolt | all bolt vertices moved on both sides → conflicts | `frame(bolt, R)` + `move(v, δ)` → the edited bolt, moved |
| Rotated the whole model | Nothing | — | the rotation |

Global frames: `T_M = merge(T_A, T_B)`. There is one special case. When both sides changed the global frame differently and one of them is a **pure unit conversion** (scale snapped to a unit factor, no rotation, no translation), the unit conversion is a change of *representation*, not of the design, so it is applied last: `T_M = U ∘ T_other`. Any other disagreement is a `global-transform` conflict.

## 4. What a conflict is

A conflict occurs when the two sides made **different, non-composable changes to the same thing**. The "things" are a vertex's residual, a vertex's existence, an anchor edge, a region of space, a part's frame, the global frame, and the vertex lineage itself.

| Kind | Condition | Why it cannot be auto-merged |
|---|---|---|
| `move-move` | Both sides locally moved v, and `\|δ_A − δ_B\| > ε`. | Two different intended positions for one point. |
| `move-delete` | One side deleted v; the other locally moved v. | The editor expects v to exist; the deleter removed it. |
| `delete-dependency` | One side deleted v; the other side's *added* faces use v as an anchor. | The new geometry would dangle. |
| `competing-additions` | Added faces from both sides share an edge (two anchors, or a unified added vertex), and they are not identical. | Both built something on the same edge. This also catches both sides re-meshing the same region differently. |
| `overlapping-additions` | Added geometry from both sides interpenetrates in space: an edge of one crosses a triangle of the other. | Two different designs of the same feature; merging both yields overlapping solids. |
| `part-motion` | Both moved the same part, differently. | Two different placements of one part. |
| `global-transform` | Both transformed the whole model, differently, and neither is a pure unit conversion. | Order and intent are ambiguous. |
| `lineage` | A side's correspondence is not one-to-one: Tier 3 with retessellation, i.e. a remesh. | Vertex-level merging needs vertex identity; transferring edits between tessellations is future work. |
| `collision` | The merged mesh has damage that neither base, ours nor theirs has: surfaces passing through each other, or faces folded over or collapsed. The damage comes only from *combining* the two sides' edits. §4.1 has the details. | Each edit is fine on its own, so no other rule flags it. Applying both still breaks the model. |

### What deliberately does **not** conflict

- **Edits to different vertices, even adjacent ones.** A vertex is a surface sample. Two nearby but disjoint sculpting edits compose. The exception is when the composition damages the surface (`collision`, §4.1).
- **One side deletes faces (a hole); the other moves a rim vertex it kept.** The hole rim follows the move.
- **One side re-triangulates a region; the other moves one of its vertices.** The new triangles use the moved vertex.
- **Convergent changes:** the same vertex moved to the same place, the same faces or vertices deleted, the same geometry added. These are applied once, not twice.
- **Additions that only share a single anchor vertex, with no shared edge and no interpenetration.** For example, two features meeting at a corner.

### 4.1 Combined-edit damage (`collision`)

Every rule above compares *edits*. Some damage exists only in the *result* of combining edits:
- Both sides push the two faces of a thin wall towards each other, so they now pass through each other.
- Two neighbouring vertices are pushed past each other, so the faces between them fold over.
- Two parts are moved into the same space.
- One side adds geometry exactly where the other side raises the surface.

None of these touch the same vertex, edge, part or frame. So the merge inspects the merged mesh itself.

**Versions.** Each merged face is compared with its three *versions*: base, ours and theirs. For each version the face gets one bit, set when the face differs from that version or does not exist in it:
- A base vertex differs from a version when its residual or part frame differs, or when the version deleted it.
- A face differs when a corner differs, or when the version lacks the face.

Only geometry that differs from **all three** versions can be new damage. A face pair is examined only when its two faces together differ from all three versions. Anything else exists as-is in some version, and each version is taken to be sound. This also covers damage a side made on its own: a side that pushes a wall through the model itself is that side's problem, not the merge's.

**Rules** (ε = the merge's move threshold, in base units):
- **Fold.** A merged face whose shape differs from all three versions is flagged in either of two cases:
  - its normal opposes the normal of every non-degenerate version of it;
  - it collapses (height below ε) where every version was non-degenerate.
  
  Shapes are compared in the base frame, with frames removed; a rigid or uniformly scaled frame never changes a shape.
- **Crossing.** Two merged faces are flagged when they cross properly and the same pair crosses in no version where both faces exist. A proper crossing means an edge of one face passes through the other: its endpoints lie more than ε on either side of that face's plane, and the hit point is inside the face.
  
  The test runs in *part space*: each version's global frame is removed and part frames are kept, so ε means the same length everywhere. Faces that share a vertex are handled by the same test. An edge through the shared vertex never has both endpoints more than ε off the plane, so it can never count.

**Regions.** A collision joins every change unit under its faces into one region: each side's change components at the corners, the added faces, and the frames of the parts involved. As with every conflict, resolving 'ours' or 'theirs' gives back that side's own geometry there, which is sound.

**Repeat until sound.** Leaving a region at the base state can expose new damage. For example, theirs dented a wall *and* lowered a block into the dent. Reverting the dent/bump collision leaves the block crossing the flat wall. So the check runs again on the new unresolved merge and adds any new collisions, until the merge is free of combined damage. Regions only grow, so this converges; a bound of 8 passes is logged if it is ever hit.

**After resolution: warnings, not conflicts.** Chosen resolutions can still combine badly with each other. For example, a region resolved 'ours' may raise a wall into geometry that another region took from 'theirs', or into theirs' automatic changes. Those are explicit choices, so the merge does not re-open them. Instead, `IMergeResult.warnings` lists the damage, with the merged faces involved and the conflicts that meet there. The CLI prints the warnings. The git merge driver exits 1 on a warning when it resolves automatically (`--resolve`), so git never commits damaged geometry unseen.

**Deliberately not detected (v1)**, because these are judgements about design, not damage:
- surfaces that only touch, or overlap in the same plane (coplanar contact);
- near misses: clearances, minimum wall thickness, tolerances;
- anything a single version already has.

**Cost.** Folds are one pass over the mixed faces. Crossings use a triangle BVH over faces near the candidates, and at most 5 M face pairs are tested (hitting the bound is logged). Measured at 100k vertices (a 50k-vertex part moved by ours plus 3000 local edits on it by theirs), the check adds about 25% to the whole merge: 0.96 s becomes 1.2 s.

## 5. Regions, which are the unit of resolution

Atomic conflicts are grouped into **regions**, the mesh analogue of a conflict hunk:

1. For each side, form **change components**. These are connected components, over base adjacency, of the base vertices that side changed: locally moved, deleted, incident to a face it deleted, or anchoring its additions. Each is joined with the added geometry attached to it. Floating additions are components of their own.
2. A conflict region is the union of every change component, **from either side**, that touches an atomic conflict, closed under overlap. Overlapping regions merge until nothing changes.
3. Part-motion conflicts cover the part's component. A collision involving a moved part adds that part's *frame* to the region. The region then decides the frame: ours' motion, theirs' motion, or none. `global-transform` and `lineage` are whole-model conflicts.

Because a region contains *entire* change components of both sides, its boundary vertices are unchanged on both sides. So resolving the region one way can never leave half of an edit behind.

**Resolution per region:** `ours` applies every change A made inside the region and none of B's; `theirs` is the reverse; `base` applies neither. For frame conflicts the choice selects the frame. For `lineage` it selects a whole mesh.

**The unresolved output is `base` for every region.** The merge reports `clean: false`, the CLI exits non-zero, and git marks the file as conflicted.

## 6. Output

- **Vertices:** kept base vertices in base order, then ours' added vertices, then theirs' added vertices. Convergent additions are included once, from ours.
- **Faces:** kept base faces in base order, keeping base winding and groups. Then ours' added faces, then theirs' added faces, each carrying their side's group name. Faces that became degenerate are dropped and counted.
- **Provenance:** every merged vertex and face records where it came from (base index, or side and index) and which side changed it. This is used for review and for the viewer.
- **Appearance** (glTF/GLB inputs): materials, per-face material assignment, per-corner UVs and texture references are merged by their own rules and carried on the merged mesh ([appearance-merge-design.md](appearance-merge-design.md) §8).
- **Formats:** OBJ (keeps groups) and binary STL writers in core. GLB output is future work.

## 7. Scope and honest limits (v1)

- Normals are not merged (they are derived data; writers recompute them). Materials, UVs and texture references are merged for glTF/GLB only; see [appearance-merge-design.md](appearance-merge-design.md) §9 for what that does not cover.
- A side that split a base component and moved half of it is seen as local moves, not a part motion. Edits on that half by the other side then conflict.
- `collision` detects crossings and folds, not design intent. It does not flag coplanar contact, clearances or wall thickness (§4.1).
- Tier 3 sides are usable only when their correspondence is one-to-one with every base face preserved: a reorder, re-export or unit conversion. A remesh produces a `lineage` conflict.
