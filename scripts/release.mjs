#!/usr/bin/env node
/**
 * Release helper, used by the two release workflows and runnable by hand:
 *
 *   node scripts/release.mjs prepare 0.3.0   bump every package.json (and the lockfile, with npm)
 *                                            to 0.3.0 and move CHANGELOG.md's "Unreleased" notes
 *                                            under "## 0.3.0 - <today>". Merging that change to
 *                                            main is what releases it (.github/workflows/release.yml).
 *   node scripts/release.mjs version         print the version all packages share (fails if they differ)
 *   node scripts/release.mjs notes 0.3.0     print the CHANGELOG notes of 0.3.0 (the GitHub Release text)
 *   node scripts/release.mjs pr-body 0.3.0   print the body of the release pull request
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSIONED, bumpManifests, changelogSection, checkNextVersion, cutChangelog, sharedVersion } from './lib/release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changelogPath = path.join(root, 'CHANGELOG.md');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const manifests = () => VERSIONED.map(readJson);

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

const [command, arg] = process.argv.slice(2);
try {
  if (command === 'version') {
    process.stdout.write(`${sharedVersion(manifests())}\n`);
  } else if (command === 'notes') {
    if (!arg) fail('usage: node scripts/release.mjs notes <version>');
    const notes = changelogSection(fs.readFileSync(changelogPath, 'utf8'), arg);
    process.stdout.write(`${notes || `See [CHANGELOG.md](https://github.com/Joshua080/polymerge/blob/v${arg}/CHANGELOG.md).`}\n`);
  } else if (command === 'pr-body') {
    if (!arg) fail('usage: node scripts/release.mjs pr-body <version>');
    const notes = changelogSection(fs.readFileSync(changelogPath, 'utf8'), arg) ?? '(no notes)';
    process.stdout.write(
      [
        `Releases **${arg}**: every package.json, the lockfile and CHANGELOG.md.`,
        '',
        '**Merging this pull request publishes it.** On the merge, `.github/workflows/release.yml` runs the full `npm run verify`, then:',
        `- publishes \`polymerge-core@${arg}\` and \`@joshuahurley/polymerge@${arg}\` to npm, with provenance;`,
        `- tags the merge \`v${arg}\` and creates the GitHub Release with the notes below;`,
        '- moves the `v1` tag (what `uses: Joshua080/polymerge@v1` runs) to it.',
        '',
        'Nothing is published if verify fails. CI does not run on a pull request a workflow opened; the release job runs the same checks before it publishes anything.',
        '',
        '### Notes',
        '',
        notes,
        '',
      ].join('\n'),
    );
  } else if (command === 'prepare') {
    if (!arg) fail('usage: node scripts/release.mjs prepare <version>   e.g. 0.3.0');
    const current = manifests();
    const from = sharedVersion(current);
    checkNextVersion(from, arg);
    const today = new Date().toISOString().slice(0, 10);
    const changelog = cutChangelog(fs.readFileSync(changelogPath, 'utf8'), arg, today); // checks before anything is written
    bumpManifests(current, arg).forEach((m, i) => fs.writeFileSync(path.join(root, VERSIONED[i]), `${JSON.stringify(m, null, 2)}\n`));
    // The lockfile records the workspace versions: let npm rewrite it rather than editing it by hand.
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    fs.writeFileSync(changelogPath, changelog);
    console.log(`release: ${from} → ${arg} in ${VERSIONED.join(', ')}, package-lock.json and CHANGELOG.md (dated ${today}).`);
    console.log('Commit it, open a pull request, and merge it: the release workflow publishes on the merge.');
  } else {
    fail('usage: node scripts/release.mjs prepare <version> | version | notes <version> | pr-body <version>');
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
