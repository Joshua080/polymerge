#!/usr/bin/env node
/**
 * prepack for the `polymerge` npm package:
 *  1. copy the built browser viewer (apps/web/dist) into dist/viewer, so `polymerge view` /
 *     `review` / `demo` work without the monorepo;
 *  2. copy the repository README in as the package README, with its relative links made
 *     absolute (npmjs.com cannot resolve paths inside the repository).
 * Fails when the CLI or the viewer has not been built, so a tarball never ships without them.
 * Logs to stderr: `npm pack --json` output on stdout must stay parseable.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(pkg, '../..');
const web = path.join(repo, 'apps/web/dist');
const out = path.join(pkg, 'dist/viewer');

if (!existsSync(path.join(pkg, 'dist/cli.js'))) throw new Error('dist/cli.js is missing — run "npm run build" at the repo root first.');
if (!existsSync(path.join(web, 'index.html'))) throw new Error(`${web}/index.html is missing — run "npm run build" at the repo root first.`);
rmSync(out, { recursive: true, force: true });
cpSync(web, out, { recursive: true });
console.error(`prepack: bundled the viewer: ${path.relative(pkg, web)} → ${path.relative(pkg, out)}`);

const GITHUB = 'https://github.com/Joshua080/polymerge';
const RAW = 'https://raw.githubusercontent.com/Joshua080/polymerge/main';
const readme = readFileSync(path.join(repo, 'README.md'), 'utf8')
  // ![alt](docs/images/x.gif) → the raw file; [text](docs/x.md#y) → the file on GitHub.
  .replace(/(!\[[^\]]*\]\()(?!https?:|#)([^)\s]+)\)/g, (_, head, rel) => `${head}${RAW}/${rel.replace(/^\.\//, '')})`)
  .replace(/((?<!!)\[[^\]]*\]\()(?!https?:|#|mailto:)([^)\s]+)\)/g, (_, head, rel) => `${head}${GITHUB}/blob/main/${rel.replace(/^\.\//, '')})`);
writeFileSync(path.join(pkg, 'README.md'), readme);
console.error('prepack: README.md ← repository README (links made absolute)');
