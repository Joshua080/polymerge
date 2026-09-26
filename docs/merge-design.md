# Three-way merge — design

Status: design for session 2; the implementation in `packages/core/src/merge/` follows this document.

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

### What deliberately does **not** conflict

- **Edits to different vertices, even adjacent ones.** A vertex is a surface sample. Two nearby but disjoint sculpting edits compose. *Future:* detect when the composition creates a collision or a flipped/degenerate face that neither side had (`collision`).
- **One side deletes faces (a hole); the other moves a rim vertex it kept.** The hole rim follows the move.
- **One side re-triangulates a region; the other moves one of its vertices.** The new triangles use the moved vertex.
- **Convergent changes:** the same vertex moved to the same place, the same faces or vertices deleted, the same geometry added. These are applied once, not twice.
- **Additions that only share a single anchor vertex, with no shared edge and no interpenetration.** For example, two features meeting at a corner.

## 5. Regions, which are the unit of resolution

Atomic conflicts are grouped into **regions**, the mesh analogue of a conflict hunk:

1. For each side, form **change components**. These are connected components, over base adjacency, of the base vertices that side changed: locally moved, deleted, incident to a face it deleted, or anchoring its additions. Each is joined with the added geometry attached to it. Floating additions are components of their own.
2. A conflict region is the union of every change component, **from either side**, that touches an atomic conflict, closed under overlap. Overlapping regions merge until nothing changes.
3. Part-motion conflicts cover the part's component. `global-transform` and `lineage` are whole-model conflicts.

Because a region contains *entire* change components of both sides, its boundary vertices are unchanged on both sides. So resolving the region one way can never leave half of an edit behind.

**Resolution per region:** `ours` applies every change A made inside the region and none of B's; `theirs` is the reverse; `base` applies neither. For frame conflicts the choice selects the frame. For `lineage` it selects a whole mesh.

**The unresolved output is `base` for every region.** The merge reports `clean: false`, the CLI exits non-zero, and git marks the file as conflicted.

## 6. Output

- **Vertices:** kept base vertices in base order, then ours' added vertices, then theirs' added vertices. Convergent additions are included once, from ours.
- **Faces:** kept base faces in base order, keeping base winding and groups. Then ours' added faces, then theirs' added faces, each carrying their side's group name. Faces that became degenerate are dropped and counted.
- **Provenance:** every merged vertex and face records where it came from (base index, or side and index) and which side changed it. This is used for review and for the viewer.
- **Formats:** OBJ (keeps groups) and binary STL writers in core. GLB output is future work.

## 7. Scope and honest limits (v1)

- Materials, UVs and normals are not merged; only geometry and groups are. The loaders do not keep UVs or normals.
- A side that split a base component and moved half of it is seen as local moves, not a part motion. Edits on that half by the other side then conflict.
- `collision` (independent edits that intersect in space only after composition) is detected only between additions, not between moved geometry.
- Tier 3 sides are usable only when their correspondence is one-to-one with every base face preserved: a reorder, re-export or unit conversion. A remesh produces a `lineage` conflict.
