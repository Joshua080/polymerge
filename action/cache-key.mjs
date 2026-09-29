#!/usr/bin/env node
/**
 * Cache keys for action.yml, printed as `name=value` lines for $GITHUB_OUTPUT:
 *   build          node_modules + the built packages: the lockfile and every build input
 *   browser        Playwright's Chromium: the Playwright version in the lockfile
 *   browsers-path  where Playwright keeps its browsers
 * (hashFiles() cannot do this: it only sees the workspace, and an action is checked out elsewhere.)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'screenshots']);

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (entry.isFile()) yield full;
  }
}

const hash = createHash('sha256');
for (const top of ['package.json', 'package-lock.json', 'tsconfig.base.json', 'packages', 'apps', 'fixtures']) {
  const full = path.join(root, top);
  if (!fs.existsSync(full)) continue;
  for (const file of fs.statSync(full).isDirectory() ? files(full) : [full]) {
    hash.update(path.relative(root, file)).update('\0').update(fs.readFileSync(file)).update('\0');
  }
}

const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const playwright = lock.packages?.['node_modules/playwright']?.version ?? 'unknown';
const platform = `${process.platform}-${process.arch}`;
const home = os.homedir();
const browsersPath =
  process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0'
    ? process.env.PLAYWRIGHT_BROWSERS_PATH
    : process.platform === 'darwin'
      ? path.join(home, 'Library/Caches/ms-playwright')
      : process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData/Local'), 'ms-playwright')
        : path.join(home, '.cache/ms-playwright');

process.stdout.write(
  [
    `build=polymerge-build-v1-${platform}-node${process.versions.node.split('.')[0]}-${hash.digest('hex').slice(0, 24)}`,
    `browser=polymerge-chromium-v1-${platform}-playwright-${playwright}`,
    `browsers-path=${browsersPath}`,
  ].join('\n') + '\n',
);
