/**
 * Guards on action.yml and the workflows that use it: the security-relevant shape that a YAML
 * typo could silently break (read as text: the repository has no YAML parser, and none is needed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const workflows = fs.readdirSync(path.join(root, '.github/workflows')).map((f) => `.github/workflows/${f}`);

/** The shell of every `run:` step: the inline value, or the indented block below `run: |`. */
function runBlocks(yaml: string): string[] {
  const lines = yaml.split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
    if (!m) return;
    if (m[2] && !/^[|>][-+]?$/.test(m[2])) return void out.push(m[2]);
    const indent = m[1].length;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > indent); j++) block.push(lines[j]);
    out.push(block.join('\n'));
  });
  return out;
}

describe('action.yml', () => {
  const yaml = read('action.yml');

  it('never interpolates an expression into shell code (inputs reach the scripts as environment variables)', () => {
    const blocks = runBlocks(yaml);
    expect(blocks.length).toBeGreaterThanOrEqual(6);
    for (const b of blocks) expect(b).not.toContain('${{');
  });

  it('runs scripts that exist', () => {
    const scripts = [...yaml.matchAll(/action\/([\w-]+\.mjs)/g)].map((m) => m[1]);
    expect(new Set(scripts)).toEqual(new Set(['render.mjs', 'cache-key.mjs', 'post.mjs']));
    for (const s of scripts) expect(fs.existsSync(path.join(root, 'action', s))).toBe(true);
  });

  it('is a composite action with the three modes', () => {
    expect(yaml).toMatch(/^runs:\n {2}using: composite$/m);
    expect(yaml).toContain('all|render|post)');
  });
});

describe('workflows', () => {
  it('never use pull_request_target, and never interpolate into shell code', () => {
    for (const w of workflows) {
      const yaml = read(w);
      expect(yaml, w).not.toMatch(/pull_request_target/);
      for (const b of runBlocks(yaml)) expect(b, w).not.toMatch(/\$\{\{\s*(github\.event|inputs)/);
    }
  });

  it('render with a read-only token, and post from workflow_run without checking out the pull request', () => {
    const render = read('.github/workflows/model-diff.yml');
    expect(render).toMatch(/^on:\n {2}pull_request:$/m);
    expect(render).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(render).toMatch(/uses: \.\/\n\s+with:\n\s+mode: render/);

    const post = read('.github/workflows/model-diff-comment.yml');
    expect(post).toMatch(/^on:\n {2}workflow_run:\n {4}workflows: \[Model diff\]/m);
    expect(post).toMatch(/^permissions: \{\}$/m);
    expect(post).toMatch(/actions: read[^\n]*\n\s+contents: write[^\n]*\n\s+pull-requests: write/);
    expect(post).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(post).not.toMatch(/ref:|head_sha|repository: \$\{\{/); // the checkout is the default branch
    expect(post).toMatch(/uses: \.\/\n\s+with:\n\s+mode: post/);
  });
});
