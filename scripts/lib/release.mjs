/**
 * Pure helpers for releasing (scripts/release.mjs and the two release workflows): the version
 * rules, and CHANGELOG.md's "Unreleased" section → a dated version section.
 * Unit-tested in scripts/test/release.test.ts.
 */

/** The package.json files that carry the shared version (relative to the repository root). */
export const VERSIONED = ['package.json', 'packages/core/package.json', 'packages/cli/package.json', 'apps/web/package.json'];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** [major, minor, patch] of a plain x.y.z version, or null. */
export function parseVersion(v) {
  const m = SEMVER.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Throws unless `next` is a plain x.y.z version greater than `current`. */
export function checkNextVersion(current, next) {
  if (!parseVersion(next)) throw new Error(`"${next}" is not a version like 0.3.0 (x.y.z, no "v", no suffix)`);
  if (compareVersions(next, current) <= 0) throw new Error(`${next} is not newer than the current version ${current}`);
}

/** Workspaces depend on each other by exact version: these names, in any dependency list. */
const INTERNAL = ['polymerge-core', '@joshuahurley/polymerge'];
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** The versions every package.json carries, and every internal dependency, must agree; returns that version. */
export function sharedVersion(manifests) {
  const found = {};
  for (const m of manifests) {
    found[m.name] = m.version;
    for (const field of DEP_FIELDS) {
      for (const dep of INTERNAL) if (m[field]?.[dep] !== undefined) found[`${m.name} → ${dep}`] = m[field][dep];
    }
  }
  const values = new Set(Object.values(found));
  if (values.size !== 1) throw new Error(`the versions differ: ${Object.entries(found).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return manifests[0].version;
}

/**
 * The manifests with `version` set everywhere, and every internal dependency set to it (npm
 * would otherwise fetch the old version from the registry instead of linking the workspace).
 */
export function bumpManifests(manifests, version) {
  return manifests.map((m) => {
    const out = { ...m, version };
    for (const field of DEP_FIELDS) {
      if (!m[field] || !INTERNAL.some((d) => m[field][d] !== undefined)) continue;
      out[field] = { ...m[field] };
      for (const dep of INTERNAL) if (out[field][dep] !== undefined) out[field][dep] = version;
    }
    return out;
  });
}

const UNRELEASED = /^## \[?Unreleased\]?[ \t]*$/im;

/** The text of one `## <heading>` section (without its heading), or null. */
function section(text, headingPattern) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => headingPattern.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The notes of one released version (for its GitHub Release), or null. */
export function changelogSection(text, version) {
  return section(text, new RegExp(`^## \\[?${escape(version)}\\]?(?:\\s|$)`));
}

/**
 * CHANGELOG.md with the "Unreleased" notes moved under `## <version> - <date>`, and a new empty
 * "Unreleased" section above them. Throws when there is nothing unreleased to release.
 */
export function cutChangelog(text, version, date) {
  if (!UNRELEASED.test(text)) throw new Error('CHANGELOG.md has no "## Unreleased" section');
  const notes = section(text, UNRELEASED);
  if (!notes || !notes.split('\n').some((l) => /^\s*[-*] \S/.test(l))) {
    throw new Error('CHANGELOG.md has nothing under "## Unreleased": list what this release changes first');
  }
  if (changelogSection(text, version) !== null) throw new Error(`CHANGELOG.md already has a section for ${version}`);
  return text.replace(UNRELEASED, `## Unreleased\n\n## ${version} - ${date}`);
}
