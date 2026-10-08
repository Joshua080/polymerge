/**
 * The part of a diff that a pull-request comment shows, as plain JSON (no typed arrays): tier,
 * vertex / face counts, moved parts, a whole-model transform (unit or scale change) and the
 * geometry metrics (size, area, volume). Pure; unit-tested in action/test/summary.test.ts.
 */

/** How many moved parts are described one by one. */
export const MAX_PARTS = 5;

/**
 * Rotation angle (degrees) of the rotation in a similarity matrix (column-major, 3×3 = scale·R).
 * atan2 of the sine (from the skew part) and the cosine (from the trace) stays exact near 0°,
 * where acos of the trace alone would turn float noise into a visible angle.
 */
export function rotationDeg(m, scale = 1) {
  const s = scale || 1;
  const r = (row, col) => m[col * 4 + row] / s;
  const sin = Math.hypot(r(2, 1) - r(1, 2), r(0, 2) - r(2, 0), r(1, 0) - r(0, 1)) / 2;
  const cos = (r(0, 0) + r(1, 1) + r(2, 2) - 1) / 2;
  return (Math.atan2(sin, cos) * 180) / Math.PI;
}

/**
 * Size, surface area and volume before and after, from IDiffResult.metrics (null when absent).
 * The unit is the one the formats state (STEP and 3MF: mm, glTF: m), null when unknown or when
 * the two versions disagree; volume is null unless both versions are closed.
 */
export function summarizeGeometry(metrics) {
  if (!metrics) return null;
  const unit = metrics.unitsDiffer ? null : (metrics.base.unit ?? metrics.target.unit ?? null);
  return {
    unit,
    size: { before: [...metrics.base.size], after: [...metrics.target.size] },
    area: { before: metrics.base.surfaceArea, after: metrics.target.surfaceArea },
    volume: metrics.volume ? { before: metrics.volume.base, after: metrics.volume.target } : null,
    closed: { before: metrics.base.volume !== null, after: metrics.target.volume !== null },
  };
}

/** How many CAD-face changes a comment lists one by one. */
export const MAX_CAD_CHANGES = 6;

/**
 * STEP: the CAD-face comparison (IDiffResult.brep), as counts and the first few changes in words.
 * The words are polymerge's own (numbers and fixed terms, never names from the file).
 */
export function summarizeCad(brep) {
  if (!brep) return null;
  return {
    faces: brep.targetFaces,
    unchanged: brep.unchanged,
    changes: brep.changes.slice(0, MAX_CAD_CHANGES).map((c) => ({ kind: c.kind, text: c.description })),
    changesTotal: brep.changes.length,
  };
}

/**
 * Summarise an IDiffResult. `named` says whether part names mean anything: an OBJ / glTF with
 * several groups has real names, a one-group mesh only repeats the file name.
 */
export function summarizeDiff(result, { named = false } = {}) {
  const s = result.stats;
  const parts = result.parts ?? [];
  const al = result.alignment;
  let transform = null;
  if (!al.isIdentity) {
    const m = al.matrix;
    transform = {
      units: al.units ? { from: al.units.from, to: al.units.to, factor: al.units.factor } : null,
      scale: al.scale,
      rotationDeg: rotationDeg(m, al.scale),
      distance: Math.hypot(m[12], m[13], m[14]),
    };
  }
  return {
    tier: result.tier,
    vertices: {
      before: result.base.vertexCount,
      after: result.target.vertexCount,
      unchanged: s.vertices.unchanged,
      moved: s.vertices.moved,
      added: s.vertices.added,
      removed: s.vertices.removed,
    },
    faces: {
      before: result.base.faceCount,
      after: result.target.faceCount,
      unchanged: s.faces.unchanged,
      modified: s.faces.modified,
      added: s.faces.added,
      removed: s.faces.removed,
    },
    maxDisplacement: s.maxDisplacement,
    parts: parts.slice(0, MAX_PARTS).map((p) => ({
      name: named ? (p.targetName ?? p.baseName ?? null) : null,
      rotationDeg: p.rotationDeg,
      distance: Math.hypot(...p.centroidShift),
    })),
    partsTotal: parts.length,
    transform,
    geometry: summarizeGeometry(result.metrics),
    cad: summarizeCad(result.brep),
  };
}

/** Whether a summary shows any local change (a whole-model transform alone is not one). */
export function hasLocalChanges(summary) {
  const v = summary.vertices;
  const f = summary.faces;
  return v.moved + v.added + v.removed + f.modified + f.added + f.removed + summary.partsTotal > 0;
}
