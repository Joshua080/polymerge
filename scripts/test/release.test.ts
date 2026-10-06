import { describe, expect, it } from 'vitest';
import { bumpManifests, changelogSection, checkNextVersion, compareVersions, cutChangelog, parseVersion, sharedVersion } from '../lib/release.mjs';

const manifests = (v = '0.2.0', dep = v) => [
  { name: 'polymerge-monorepo', version: v },
  { name: 'polymerge-core', version: v },
  { name: '@joshuahurley/polymerge', version: v, dependencies: { 'polymerge-core': dep, three: '^0.180.0' } },
  { name: '@polymerge/web', version: v, dependencies: { 'polymerge-core': dep, three: '^0.180.0' }, devDependencies: { vite: '^8' } },
];

const CHANGELOG = `# Changelog

Intro.

## Unreleased

### Added
- STEP files.

## 0.2.0 - 2026-10-05

### Added
- The CLI.
`;

describe('versions', () => {
  it('parses and compares plain x.y.z versions', () => {
    expect(parseVersion('0.10.2')).toEqual([0, 10, 2]);
    expect(parseVersion('v1.0.0')).toBeNull();
    expect(parseVersion('1.0.0-beta.1')).toBeNull();
    expect(parseVersion('01.0.0')).toBeNull();
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
  });

  it('accepts only a newer version', () => {
    expect(() => checkNextVersion('0.2.0', '0.3.0')).not.toThrow();
    expect(() => checkNextVersion('0.2.0', '0.2.0')).toThrow(/not newer/);
    expect(() => checkNextVersion('0.2.0', '0.1.9')).toThrow(/not newer/);
    expect(() => checkNextVersion('0.2.0', 'v0.3.0')).toThrow(/not a version like 0\.3\.0/);
  });

  it('needs every package at one version, including the CLI dependency on core', () => {
    expect(sharedVersion(manifests())).toBe('0.2.0');
    expect(() => sharedVersion(manifests('0.2.0', '0.1.0'))).toThrow(/the versions differ.*@joshuahurley\/polymerge → polymerge-core 0\.1\.0/);
  });

  it('bumps every package and the exact core dependency, keeping everything else', () => {
    const out = bumpManifests(manifests(), '0.3.0');
    expect(sharedVersion(out)).toBe('0.3.0');
    expect(out[2].dependencies).toEqual({ 'polymerge-core': '0.3.0', three: '^0.180.0' });
    expect(out[3].dependencies).toEqual({ 'polymerge-core': '0.3.0', three: '^0.180.0' });
    expect(out[3].devDependencies).toEqual({ vite: '^8' });
    expect(Object.keys(out[2])).toEqual(['name', 'version', 'dependencies']);
  });
});

describe('changelog', () => {
  it('moves the Unreleased notes under the new version, with a fresh Unreleased above', () => {
    const cut = cutChangelog(CHANGELOG, '0.3.0', '2026-10-06');
    expect(cut).toContain('## Unreleased\n\n## 0.3.0 - 2026-10-06\n\n### Added\n- STEP files.\n\n## 0.2.0 - 2026-10-05');
    expect(changelogSection(cut, '0.3.0')).toBe('### Added\n- STEP files.');
    expect(changelogSection(cut, '0.2.0')).toBe('### Added\n- The CLI.');
    expect(changelogSection(cut, 'Unreleased')).toBe('');
  });

  it('refuses a release with nothing unreleased, or a version already listed', () => {
    const empty = cutChangelog(CHANGELOG, '0.3.0', '2026-10-06');
    expect(() => cutChangelog(empty, '0.4.0', '2026-10-07')).toThrow(/nothing under "## Unreleased"/);
    expect(() => cutChangelog(CHANGELOG, '0.2.0', '2026-10-06')).toThrow(/already has a section for 0\.2\.0/);
    expect(() => cutChangelog('# Changelog\n', '0.3.0', '2026-10-06')).toThrow(/no "## Unreleased"/);
  });

  it('finds a version section by its exact number', () => {
    expect(changelogSection(CHANGELOG, '0.2')).toBeNull();
    expect(changelogSection(CHANGELOG, '0.2.0')).toBe('### Added\n- The CLI.');
  });
});
