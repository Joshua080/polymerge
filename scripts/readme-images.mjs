#!/usr/bin/env node
/**
 * Regenerates the README images from the real viewer (headless Chromium, the built CLI's server):
 *   docs/images/diff-viewer.png     the diff viewer on the mixed-topology-edit example
 *   docs/images/merge-review.gif    the merge review: select a conflict, preview both sides, resolve
 *   docs/images/action-card.png     the pull-request image (docs/github-action.md): the capture
 *                                   card of the moved-part example, as the GitHub Action renders it
 *
 *   npm run build && node scripts/readme-images.mjs
 *
 * The server, the browser and the ready-wait are scripts/viewer-capture.mjs, which the GitHub
 * Action's pull-request images use too. The GIF is encoded with Python's Pillow
 * (`pip install pillow`). Not part of CI.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, startViewer, waitReady } from './viewer-capture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/images');
const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-frames-'));
fs.mkdirSync(outDir, { recursive: true });

const viewer = await startViewer(); // `polymerge demo`: the viewer with its built-in examples
const origin = viewer.origin;
const browser = await launchBrowser();
const ready = (page) => waitReady(page);

/** Wait for a resolve round-trip: the state goes to 'loading', then settles. */
async function settle(page, action) {
  await page.evaluate(() => {
    window.__settled = new Promise((resolve) => {
      let sawLoading = false;
      const obs = new MutationObserver(() => {
        const state = document.body.dataset.state;
        if (state === 'loading') sawLoading = true;
        else if (sawLoading) {
          obs.disconnect();
          resolve(state);
        }
      });
      obs.observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
    });
  });
  await action();
  await page.evaluate(() => window.__settled);
}

/** A drawn mouse pointer (headless screenshots have none), moved together with the real mouse. */
async function pointerTo(page, x, y) {
  await page.evaluate(
    ([px, py]) => {
      let el = document.getElementById('__pointer');
      if (!el) {
        el = document.createElement('div');
        el.id = '__pointer';
        el.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;width:22px;height:22px;';
        el.innerHTML =
          '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
        document.body.append(el);
      }
      el.style.left = `${px - 3}px`;
      el.style.top = `${py - 2}px`;
    },
    [x, y],
  );
  await page.mouse.move(x, y);
}

/** Canvas-relative centre of the orange (unresolved conflict) pixels. */
async function orangeCentre(page) {
  const png = await page.locator('canvas').screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, gg, b] = [d[i], d[i + 1], d[i + 2]];
      if (r > 120 && r > gg * 1.6 && gg > b * 1.5) {
        const p = i / 4;
        sx += p % c.width;
        sy += Math.floor(p / c.width);
        n++;
      }
    }
    return n ? [sx / n, sy / n] : null;
  }, png.toString('base64'));
}

try {
  // 1. The diff viewer.
  const diff = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await diff.goto(`${origin}/?case=mixed-topology-edit`);
  await ready(diff);
  await diff.waitForTimeout(500);
  await diff.screenshot({ path: path.join(outDir, 'diff-viewer.png') });
  await diff.close();
  console.log('readme-images: docs/images/diff-viewer.png');

  // 2. The pull-request image: the capture card, at the size and scale action/render.mjs uses.
  const card = await browser.newPage({ viewport: { width: 800, height: 700 }, deviceScaleFactor: 2 });
  const models = new URLSearchParams({ capture: '1', before: 'main', after: 'my-branch', base: 'fixtures/cases/moved-part/base.obj', target: 'fixtures/cases/moved-part/target.obj' });
  await card.goto(`${origin}/?${models}`);
  await ready(card);
  await card.locator('#capture').screenshot({ path: path.join(outDir, 'action-card.png') });
  await card.close();
  console.log('readme-images: docs/images/action-card.png');

  // 3. The merge review, as frames: [file, duration ms].
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${origin}/?mode=merge&demo=boss-height`);
  await ready(page);
  await page.keyboard.press('Escape');
  const box = await page.locator('canvas').boundingBox();
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  // A slight tilt, so the plate's thickness and the raised boss read as 3D.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 40, cy + 30, { steps: 12 });
  await page.mouse.up();
  await page.mouse.wheel(0, -250);
  await page.waitForTimeout(400);

  const list = [];
  const frame = async (ms) => {
    await page.waitForTimeout(250);
    const file = path.join(frames, `${String(list.length).padStart(2, '0')}.png`);
    await page.screenshot({ path: file });
    list.push([file, ms]);
  };
  const at = await orangeCentre(page);
  if (!at) throw new Error('no orange conflict region found on the canvas');
  const region = [box.x + at[0], box.y + at[1]];
  const button = async (pick) => {
    const b = await page.locator(`[data-conflict="0"] [data-pick="${pick}"]`).boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };

  await pointerTo(page, cx + 260, cy + 220);
  await frame(1800); // the merge: automatic edits in blue / purple, the conflict in orange
  await pointerTo(page, ...region);
  await frame(500);
  await page.mouse.click(...region);
  await frame(1700); // selected: ours / theirs outlines in place
  const ours = await button('ours');
  await pointerTo(page, ...ours);
  await frame(1500); // hover = preview ours, filled
  const theirs = await button('theirs');
  await pointerTo(page, ...theirs);
  await frame(1500); // preview theirs
  await settle(page, () => page.mouse.click(...theirs));
  await frame(3000); // resolved to theirs
  await page.close();

  const gif = path.join(outDir, 'merge-review.gif');
  execFileSync(
    'python3',
    [
      '-c',
      `import json, sys
from PIL import Image
frames = json.loads(sys.argv[1])
rgb = [Image.open(f).convert('RGB') for f, _ in frames]
rgb = [im.resize((im.width * 3 // 4, im.height * 3 // 4), Image.LANCZOS) for im in rgb]
# One palette from all frames together, so every UI colour keeps its hue in every frame.
# The merge colours get a block of their own, so small swatches keep their exact hue too.
keys = ['#3b82f6', '#a855f7', '#14b8a6', '#f97316', '#9ca3af', '#22c55e', '#ef4444', '#eab308']
sheet = Image.new('RGB', (rgb[0].width, rgb[0].height * (len(rgb) + 1)))
for i, im in enumerate(rgb):
    sheet.paste(im, (0, i * im.height))
for i, c in enumerate(keys):
    sheet.paste(Image.new('RGB', (rgb[0].width // len(keys), rgb[0].height), c), (i * (rgb[0].width // len(keys)), len(rgb) * rgb[0].height))
palette = sheet.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
ims = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in rgb]
ims[0].save(sys.argv[2], save_all=True, append_images=ims[1:], duration=[d for _, d in frames], loop=0, optimize=True, disposal=1)`,
      JSON.stringify(list),
      gif,
    ],
    { stdio: 'inherit' },
  );
  console.log(`readme-images: docs/images/merge-review.gif (${list.length} frames, ${(fs.statSync(gif).size / 1024).toFixed(0)} kB)`);
} finally {
  await browser.close();
  viewer.stop();
  fs.rmSync(frames, { recursive: true, force: true });
}
