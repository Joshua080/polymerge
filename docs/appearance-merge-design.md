# Appearance merge — design (materials, UVs, texture references)

Status: written before the implementation. It extends the three-way merge in [merge-design.md](merge-design.md), whose terms (base O, ours A, theirs B, change components, regions, `base` when unresolved) it reuses. The implementation targets glTF/GLB, the one input format that carries materials, texture references and UVs.

The geometry merge answers "where is each point of the surface?". Appearance asks different questions: *what is this surface made of*, and *which texel lands on which point*. Those answers have different units of meaning, different identities and different ways of going wrong. This document works them out rather than renaming the geometry rules.

---

## 1. Why the geometry rules do not transfer

| Geometry | Appearance | Consequence |
|---|---|---|
| A vertex is a sample of a *continuous* surface. Half of a shape edit leaves a step or a crease, so regions take whole change components (D14). | A face's material is *piecewise constant*: boundaries between materials are normal and expected. A door painted red with a chrome handle is a paint job, not damage. | Material assignment merges **face by face**. A conflict covers only the faces both sides assigned differently, not the whole of each repaint. |
| — | A UV layout is continuous *inside an island* and deliberately torn at seams. An island is only correct as a whole: it is laid out as one piece against one image. | UVs merge **island by island**, never corner by corner. Half an island from each side is garbage even when no corner was changed twice. |
| Vertex identity comes from the diff (correspondence). | Material identity is a *name* the user chose; images are *bytes*. Neither has positions to match. | Materials match by name (with rename detection), images by content. |
| Positions are meaningful on their own. | UVs mean nothing without the image they index. Moving an island changes *which texels* it shows. | Texture-space overlap matters only between islands that sample the same image. Texel content is never judged. |
| A material property has no geometric extent. | A material is a set of independent BRDF parameters (colour, metalness, roughness, …) shared by every face that uses it. | Definitions merge **property by property**, like frames and residuals compose; a texture slot is one property. |
| Deleting a vertex another side moved is `move-delete`. | Painting a face another side deleted does no harm: nothing is left to paint. But painting a surface the other side *replaced* is silently lost on the replacement. | Deletion wins over an appearance edit; replacement does not (it is a conflict that also decides the geometry). |

## 2. The data and its unit of meaning

| Data | Where it lives | Unit of meaning | Merged |
|---|---|---|---|
| Material **definition**: base colour factor (RGBA), metallic, roughness, emissive factor, alpha mode, alpha cutoff, double-sided, name, the five core texture slots, each other material extension (e.g. `KHR_materials_unlit`, `KHR_materials_emissive_strength`), `extras` | `IMesh.appearance.materials[i]`, parallel to `IMesh.materials[i]` | One **property**. A colour is one value (RGBA together): mixing ours' red channel with theirs' green channel gives a colour nobody chose. | Property by property |
| **Texture slot** (e.g. `baseColorTexture`): image, UV set (`texCoord`), sampler (filters, wrap), `KHR_texture_transform`, normal scale / occlusion strength | inside the definition | The **whole slot**. Ours' image with theirs' transform or UV set samples the wrong texels. | As one property |
| Material **assignment** | `IMesh.faceMaterials[face]` | One **face**. No continuity between neighbours. | Face by face |
| **UVs** (`TEXCOORD_0`, `TEXCOORD_1`, …) | `IMesh.appearance.uvs[set]`, per *face corner* | The **island** (chart): faces glued along edges whose two end corners carry the same UVs. Vertices weld by position, but a vertex on a seam has different UVs in the faces on either side, so UVs belong to corners, not to welded vertices. | Whole islands of every version |
| **Images** | `IMesh.appearance.images`, referenced by slots | The **whole image**. Embedded bytes (GLB bufferView or `data:` URI) are carried as is and never decoded; an external URI is kept as a reference and never fetched. | As part of a slot |
| Vertex colours (`COLOR_0`) | not parsed | A per-corner *sample*, like a position: adjacent brush strokes compose. | Not in v1 (§9) |

Normals and tangents are derived data; writers recompute them, so they are not merged.

## 3. Identity: which thing in ours is which thing in base

**Faces and corners** come from the geometry merge, which is never recomputed. A base face is *kept* on a side when its three corners map to a face of that side (merge-design §2). Its corners are matched **by vertex**, because a side may store the same triangle with its corners rotated. Faces a side added carry their own appearance and have no base counterpart.

**Materials.** An index means nothing: the loader keeps only materials that faces use, in first-use order, so reordering faces renumbers materials. What users see and edit is the **name**, so identity is:
1. **Same name.** Two materials with the same name within one version are told apart by their rank among same-named materials (`Paint`, `Paint#2`). An unnamed glTF material gets the loader's name `material_<index>`: index identity is the only one it has.
2. **Rename.** A base material whose name vanished on a side, and a new name on that side, are one material when they are each other's most frequent partner over the kept faces and that pairing covers more than half of the base material's kept faces. A material renamed *and* edited is still the same material. A new material that takes over all of a vanished material's faces reads as a rename: in the file the two are indistinguishable, and treating it as a rename lets the other side's edits to the material carry over.
3. **New.** Anything else is new, identified by its name. New materials of the same name on both sides are the same identity (add/add); their base values are the glTF defaults, which is what an absent property means in glTF.

Reordering is irrelevant. A rename on one side and an edit on the other merge: the new name, with the edited properties.

**Images** are identified by **content**: a 64-bit hash of the embedded bytes, or the external URI as written. Renaming an image or moving it between the GLB buffer and a `data:` URI changes nothing; the same pixels re-encoded, or an embedded copy of an external file, are different images.

**Islands** are computed per version from its own corner UVs, so a side that cuts, stitches or re-packs islands is seen as such.

## 4. What a change is

Each side is compared with the base, using the geometry merge's correspondence:

| Change | On side S |
|---|---|
| property change | a property of a matched material differs from the base value (numbers compared exactly, colours per channel, slots and extensions as whole values with images compared by content) |
| re-assignment | a kept base face whose material identity differs from the base's |
| UV change | a kept base face with a corner whose UV differs from the base's by more than ε_uv in `u` or `v`, in some set; ε_uv = 2⁻¹⁶ ≈ 1.5·10⁻⁵ (1/16 of a texel at 4096 px, and above the rounding of a 16-bit re-quantised export) |
| new UVs | a face S added that has UVs |

**UV change components.** For UV set k, glue faces that share an edge with matching UVs at both ends: in the base (base islands), and in S (S islands, on S's kept and added faces). A **super-island** is a connected component of the *union* of both gluings. The UV change components of S are the super-islands containing a UV change or new UVs. Each is closed under base islands and S islands, so it never splits an island of either version.

## 5. What a conflict is

A conflict needs two changes to the **same unit** that cannot both hold, or a combination that only exists because both were applied. The appearance kinds:

| Kind | Condition | Unit a user resolves |
|---|---|---|
| `material-property` | Both sides changed the same property of the same material to different values. An add/add material with different values is the same case, against glTF defaults. | The material: all its conflicting properties. Its other properties still merge. |
| `material-assignment` | Both sides re-assigned the same kept face to different materials. | A patch: faces in conflict connected through shared edges. |
| `uv-layout` | A UV change component of ours and one of theirs share a face, and their union is not taken whole from one side (below). | The union of every overlapping component: whole islands of base, ours *and* theirs. |
| `uv-overlap` | Islands whose UVs come from different sides now overlap in texture space with positive area, sample a common image through that UV set, and overlap in no version (base, ours, theirs). | The union of the components involved. |
| `appearance-geometry` | The appearance unit cannot be decided without also deciding geometry: one side *replaced* faces (deleted them, with additions in the same change component) whose material or UVs the other side changed; or a UV unit in conflict contains faces added by a side; or both sides added the same face with different appearance. | A geometry **region**, which then also decides those appearance units. |

**Taking a UV union whole.** Overlapping components of the two sides form a union U. If the two sides give identical UVs on every face of U kept by both, U is convergent. If every face theirs changed in U has ours' UVs there (theirs' edits are a subset of ours'), U is taken whole from ours, which already contains theirs' edits; symmetrically for theirs. Otherwise U is a `uv-layout` conflict. Per-face three-way merging inside U is never used: it tears islands. An example is ours moving island I while theirs stitches island J onto I's *old* position. Every face would merge "cleanly", and J would end up glued to nothing.

**Texture-space overlap** is the appearance analogue of the `collision` check (merge-design §4.1). Two sides each move a *different* island into the same empty corner of the texture. No face is changed twice, yet both islands now show the same texels. Like `collision`, it uses version bits. A face's merged UVs are compared with each version, and a pair is examined only when the two faces together differ from base, ours and theirs. Such a pair counts when:
- the two UV triangles overlap with positive area (separating-axis test, ε_uv margin);
- both faces' materials sample a **common image** through that UV set;
- the pair overlaps in no version where both faces exist.

Leaving a unit at base can expose a new overlap, so the check repeats until nothing new is found, as `collision` does. Only overlap in raw UV coordinates is judged: that provably shows the same texels under any sampler.

**Deliberately not conflicts:**
- **Different properties of one material.** Ours makes it metallic, theirs darkens its colour: a dark metal. They are independent parameters.
- **Neighbouring re-assignments.** Ours paints faces 1–50 blue, theirs 51–100 red: both apply. Material boundaries are not damage.
- **A repaint over a smaller repaint.** Ours paints the door red, theirs the handle chrome: only the handle faces conflict. Resolved "theirs", the door is red with a chrome handle.
- **Deletion plus an appearance edit.** One side cuts a hole where the other repainted or re-UV'd: nothing is left to paint, and the rest of the edit still applies.
- **A UV edit on one side and an image edit on the other.** The edited UVs sample the other side's new image. Both edits were made against the base; whether the new texels suit the new layout is texel content, which is not judged (§9).
- **The same change on both sides**: the same property value, the same image (by content), the same assignment, the same UV layout.
- **A side's own texture-space overlaps** (stacked or mirrored UVs): they exist in that version.
- **Materials no face uses any more.** They are not written. An edit to a material that the other side stopped using has nothing left to apply to.

## 6. Orthogonality with geometry

Appearance and shape are independent attributes of a kept face, so their edits compose:

| Ours | Theirs | Result |
|---|---|---|
| Moves vertices / a part / the whole model | Repaints or re-UVs the same faces | Both: the new shape carries theirs' appearance. UVs are not rescaled for the new shape. |
| Retriangulates or remeshes a region (deletes and adds faces) | Repaints or re-UVs faces there | `appearance-geometry`: theirs' edit would silently vanish on ours' new faces. Transferring it across tessellations is future work, like `lineage`. |
| Deletes faces (a hole, no replacement) | Repaints or re-UVs them | The hole. Theirs' edit applies to what remains. |
| Adds faces glued (in UV space) to an island | Moves that island | `appearance-geometry`: the new faces are laid out against the old position. |
| Adds faces | — | They keep ours' material and UVs. |
| A geometry conflict region | An appearance edit on its faces | Independent. Resolving the geometry does not undo the appearance edit, and vice versa. |

The coupled kind exists because an appearance unit that contains *added faces* cannot be resolved by appearance alone. Resolving "the other side" would have to give those faces UVs from a version where they do not exist. So the unit becomes part of a geometry region: its atomic conflict is added to the plan (as `collision` atomics are) together with every added face in the units it owns. Resolving the region then decides the additions and the appearance together: "ours" gives ours' geometry *and* ours' appearance there, and so on. Regions already own part frames this way.

## 7. Resolution, ids, reporting

- **One id space.** Appearance conflicts are appended to `IMergeResult.conflicts` after the geometry conflicts, in a fixed order: material properties (by material), assignment patches, then UV units (by set, then first face). Geometry ids are unchanged, and for inputs without appearance data nothing changes at all. `--pick <id>=ours|theirs|base`, `--resolve` and `resolveMerge` work unchanged, and so does the viewer's resolve path. An `appearance-geometry` conflict is part of a geometry region and shows among that region's kinds.
- **Details.** Each appearance conflict has `appearance: { material?, properties?, uvSet? }`. `baseFaces` / `baseVertices` list the faces involved (for a material, the base faces using it), and `focus` is their centre.
- **Unresolved = base**, per unit, as for geometry (D14): the base property values (glTF defaults for an add/add material), the base assignment on the patch, the base UVs on every face of the UV unit. `clean` is false while any conflict is unresolved, so the CLI exits 1 and the git driver marks the file conflicted.
- **After resolution.** Chosen resolutions can still combine into a texture-space overlap. As with `collision`, that is a warning (`kind: 'uv-overlap'`), not a re-opened conflict. The git driver with `--resolve` stops on it.
- **Reporting.** The CLI lists appearance conflicts with the others (kind, material name and properties, or faces and UV set), prints an "Appearance" line with what was applied from each side, and includes both in `--report` JSON.

## 8. Output

The merged mesh carries appearance like a loaded glTF:
- `faceMaterials` and `materials`, where the summaries are derived from the definitions;
- `appearance.materials`: the merged definitions, only those some merged face uses, in first-use order;
- `appearance.images`: those the definitions reference;
- `appearance.uvs`: per merged face corner, in the merged face's corner order.

`IMergeResult.appearance` reports statistics and, per merged face, who decided its appearance and which appearance conflict (if any) holds it. A `lineage` merge copies the chosen whole side's appearance. The appearance merge runs only when base, ours and theirs all carry appearance data. Otherwise the merge logs why and emits geometry only, as before.

**Cost.** Everything is linear: one pass over faces and corners per side, union-find over edges for islands, and a uniform grid in UV space over faces whose UVs came from different sides. None of it runs for STL/OBJ, which have no appearance data.

## 9. Scope and honest limits

- **Texel content is never merged or judged.** Two different images in one slot are a conflict; a new image under an edited UV layout is merged unjudged.
- **Texture-space overlap is judged only when provable:** raw UV overlap between islands sampling the same image. The check does not detect:
  - overlap through wrapping (`REPEAT` beyond [0, 1]);
  - overlap through `KHR_texture_transform`;
  - an overlap created only by combined *re-assignments* (two overlapping islands that come to share an image because each side re-assigned one).
- **No appearance transfer across tessellations.** A remeshed region with a repaint on the other side is a conflict, not a transfer.
- **Not merged:**
  - vertex colours (they would merge per corner like positions: same corner, different colours = conflict);
  - normals and tangents;
  - `KHR_materials_variants`;
  - animated material properties;
  - morph-target UVs;
  - OBJ `vt` / `.mtl` and STL colours. The same rules would apply; only glTF feeds them in v1.
- **Material names:** if one side renames a material to a name the other side newly introduces, the merged file has two materials with that name. Both are kept, distinct.
- **Images differing only in encoding** are different images.
