# polymerge — DEVLOG

A living log of milestones, architectural decisions, what works, what is stubbed, known bugs and next steps. Newest session at the top; entries within a session are in order.

---

## Session 6 — 2026-09-28 — CLI package renamed to `@joshuahurley/polymerge`, version 0.1.1

npm refused to publish the CLI as `polymerge`: E403, too similar to the existing package `poly-merge`. `polymerge-core@0.1.0` did get published before that failure.
- **The rename.** The CLI package is now **`@joshuahurley/polymerge`**, with `publishConfig.access: public`, since scoped packages are private by default. Its `bin` is still `polymerge`, so the command people type is unchanged.
- **Updated references:**
  - the root build script;
  - the README install lines: `npm install -g @joshuahurley/polymerge`, `npx @joshuahurley/polymerge demo`, `npm link -w @joshuahurley/polymerge`;
  - the README release section and `polymerge git-setup`'s hint;
  - the pointer in `packages/core/README.md`;
  - `scripts/e2e-pack.mjs` (pack, find and install the scoped package);
  - the release workflow.
- **Version 0.1.1 everywhere.** Both published packages, their dependency on each other, the viewer workspace and the root. 0.1.0 of `polymerge-core` is already taken, and npm never allows reusing a version.
- **Safe re-runs.** The release workflow skips any package whose exact version is already on npm, and publishes the rest.
  - The old check trusted `npm view`'s exit code. Depending on the npm version, a missing version either exits non-zero or prints nothing with exit 0, and the second would have been read as "already published".
  - The check now compares the printed version with the one being released.
  - Checked locally: `polymerge-core@0.1.0` → skip (already on npm); `polymerge-core@0.1.1` and `@joshuahurley/polymerge@0.1.1` → publish.
- **Not done.** Nothing is tagged or published.

| # | Decision | Why |
|---|----------|-----|
| D25 | The CLI is published as `@joshuahurley/polymerge`, with the `polymerge` bin (supersedes the unscoped name in D22). | npm's name-similarity rule rejects `polymerge`; a personal scope can't collide, and the command is unchanged. |

---

## Session 5 — 2026-09-28 — engine package renamed to `polymerge-core`

The npm org `polymerge` is taken by someone else, so `@polymerge/core` could never be published.
- **The rename.** The engine is now the unscoped **`polymerge-core`** everywhere:
  - package.json files and the lockfile;
  - every import (core, CLI, viewer, tests, e2e scripts);
  - the vite/vitest source aliases;
  - the README and its library example, and `packages/core/README.md`;
  - the pack/install check (`scripts/e2e-pack.mjs`) and the release workflow.
- **Name check.** `npm view polymerge` and `npm view polymerge-core` both return 404 on 2026-09-28, so both names are free.
- **Unchanged.** The private workspace `@polymerge/web` keeps its scope; it is never published.
- **Session 4 entries.** They still say `@polymerge/core`, as the record of what was true then; D22 now reads "the engine as `polymerge-core`".
- **Not done.** Nothing is tagged or published yet.

---

## Session 4 — 2026-09-27 — README, npm packaging

Priorities set by the owner:
1. A proper README: what the tool does, a screenshot or GIF of the viewer, install instructions, and the basic diff/view/merge commands with real examples.
2. Check whether polymerge can be installed from npm as a real package, not only cloned and run; if not, get it there.
3. State honestly in the README what v1 does and doesn't handle.

### Milestone 1 — Installable from npm ✅

**What was wrong.** The packages had `files` and a `bin`, but a published CLI would not have worked:
- **The viewer was not in the package.** `polymerge view` looked for the built viewer only at the monorepo's `apps/web/dist`. An installed `polymerge` would have failed with "Could not find the built web viewer".
- **The name.** `@polymerge/cli` needs the npm org `polymerge`, and it is not what anyone would type. The command is `polymerge`, so the package should be too.
- **Metadata:**
  - no repository / homepage / bugs / keywords;
  - no README or LICENSE inside either package;
  - no `publishConfig.access`, and a scoped package is private by default;
  - source maps pointing at sources that were never shipped.
- The version was hard-coded in `cli.ts` apart from `package.json`.

**Changes.**
- **Package names.** The CLI is now the unscoped **`polymerge`** (`npm install -g polymerge`, `npx polymerge`). The engine stays **`@polymerge/core`**, with `publishConfig.access: public`. Both names are free on the registry (404 on 2026-09-27).
- **The viewer is bundled at pack time.** `packages/cli/scripts/prepack.mjs` copies `apps/web/dist` into `dist/viewer`. It fails if the CLI or the viewer is not built, so a tarball can never ship without them. `resolveWebDist` looks in this order:
  1. `--web-dist`;
  2. `$POLYMERGE_WEB_DIST`;
  3. the monorepo's `apps/web/dist`, so a clone always serves a freshly built viewer;
  4. the bundled `dist/viewer`.
- **The npm README.** `prepack` also copies the repository README in as the package README, with relative links made absolute (npmjs.com cannot resolve repository paths). `@polymerge/core` has its own short README.
- **Package contents.** Metadata, LICENSE copies and `engines: node >= 20` for both packages. Source maps are excluded. The CLI reads its version from `package.json`.
- **`polymerge demo [example]`** (new). It opens the viewer on a built-in example with no files: the merge examples, or any diff fixture bundled with the viewer. Someone who has just installed the package can see what it does in one command.

**Proof: `scripts/e2e-pack.mjs`**, now part of `npm run e2e`, so CI runs it on every push.
1. It runs `npm pack` for both packages and checks the tarball contents: the viewer, the fixtures manifest, the README and the LICENSE, with no sources and no source maps.
2. It installs the two tarballs into an **empty project**.
3. It uses the installed copy:
   - `--version` matches the package;
   - `diff` exits 1 on a moved part;
   - the README's library example runs verbatim against the installed `@polymerge/core`;
   - `merge` reports the conflict and resolves with `--pick`;
   - `demo` serves the bundled viewer;
   - `view` renders a real diff in headless Chromium, through `e2e-view` pointed at the installed `cli.js`.

**Releasing.** `.github/workflows/release.yml` runs on a `v*` tag. It checks that the tag, both package versions and the CLI's core dependency agree, then runs the full `npm run verify`. After that it publishes `@polymerge/core` and then `polymerge`, with npm provenance. A version that is already on the registry is skipped, so a failed release can be re-run.

**Not done: the actual publish.** It needs the owner's npm account (a repository secret `NPM_TOKEN`), and a publish cannot really be undone. Until then the README says plainly that the packages are not on npm yet, and gives the from-source install. `npm publish --dry-run` for `polymerge` succeeds.

| # | Decision | Why |
|---|----------|-----|
| D22 | The CLI is published as the unscoped `polymerge`; the engine as `polymerge-core` (renamed from `@polymerge/core` in session 5: the npm org was taken). | People install the command they type. Library users get a clearly separate engine package. |
| D23 | The viewer is copied into the CLI package at `prepack`, not at build. A clone prefers its own `apps/web/dist`. | The tarball always carries the viewer it was built with, and development never serves a stale copy. |
| D24 | Packaging is tested by installing the packed tarballs into an empty project on every CI run. | "Works from the clone" says nothing about the package. The one real bug here (the missing viewer) was exactly of that kind. |

### Milestone 2 — README ✅

The README was rewritten for someone who has never seen the project:
- what the tool does and how it differs from a deviation heatmap;
- a GIF of the merge review and a screenshot of the diff viewer;
- install instructions, with the release status stated;
- diff / view / merge / review / git / library usage.

**Every command output in it is a real run**, lightly trimmed where marked with "…". It uses files in the repository: `fixtures/cases/*`, and the new `examples/plate/` (base / ours / theirs STL of the `boss-height` merge example: one move-move conflict and two automatic edits). The library example is the exact code `e2e-pack` runs against the installed package, so the README cannot silently drift from the API.

While writing it, I found that `logger: null` does not silence the engine (it falls back to the console), so the README documents `logger: { info() {}, warn() {} }` instead.

**"What v1 does and doesn't handle"** collects the limits in one place:
- `docs/merge-design.md` §4.1 and §7: no judgement of contact, clearance or wall thickness; remeshed sides give a whole-model `lineage` conflict; split parts; no material/UV merge;
- the diff's ambiguous cases: identical copy vs. move, symmetric shapes, lattice shift, far-dragged regions;
- input formats that are not supported;
- the viewer's Y-up camera, and the review not writing back to the repository.

**Images.** `scripts/readme-images.mjs` regenerates them from the real viewer (headless Chromium + the built CLI's server), so they can be refreshed whenever the UI changes:
- `docs/images/diff-viewer.png`: the `mixed-topology-edit` example.
- `docs/images/merge-review.gif`: six frames, 124 kB. Select the conflict by clicking it in 3D, preview ours, preview theirs, click Theirs.
  - The model is tilted slightly, so the plate reads as 3D.
  - A drawn pointer shows what is being clicked (headless screenshots have none).
  - One shared palette, with the merge colours pinned, keeps every colour exact across frames.

### State at end of session 4

**Verified.** `npm run verify` passes locally in 1m07s. It covers:
- typecheck;
- 458 unit / fixture / merge / web tests and 4 perf tests;
- build;
- smoke (21/21 browser cases), e2e-view, e2e-worker, e2e-merge, e2e-git, and the new e2e-pack.

**Known limits / next steps** (carried over from session 3, minus npm packaging):
1. **Publish v0.1.0.** Add the `NPM_TOKEN` secret and push the tag `v0.1.0`. If the `@polymerge` npm scope turns out to be unavailable, rename the engine package (e.g. `polymerge-core`) before the first release.
2. Collision check scope (v1, by decision): coplanar contact, clearances, wall thickness and design intent are not judged (D16).
3. Deformation transfer for `lineage` conflicts.
4. Saving from the merge review straight into the repository (needs a write endpoint, with its own security review).
5. A GLB/glTF writer, and merging materials/UVs.
6. Parsing in the worker; chunked scene building for very large results.
7. Z-up models: a per-model "up" choice in the viewer.

---

## Session 3 — 2026-09-26 — CI, combined-edit collisions, merge review in the viewer

Priorities set by the owner:
1. GitHub Actions CI running `npm run verify` on every push. Until now the project was verified on trust alone.
2. Take a hard look at the "combined edits" gap: two edits that don't conflict individually but produce bad geometry together. Decide explicitly whether it is solvable now, then fix it or document it.
3. Conflict display and click-to-resolve in the browser viewer.
4. If time remains, investigate the 12-minute browser test stall properly.

PR #1 was merged into `main` first (merge commit `557955a`). This session works on `claude/optimistic-franklin-u4oplc`, restarted from that `main`, with a new PR.

### Milestone 1 — CI on every push ✅

`.github/workflows/ci.yml` runs `npm run verify` on every push to any branch, and on pull requests from forks. That covers typecheck, unit/fixture/merge tests, perf tests, build, and every end-to-end suite: 21 browser cases, CLI → browser, worker responsiveness, real-git merge, and (since milestone 3) the merge review.
- Runs on Ubuntu with Node 22, `npm ci`, and Playwright's Chromium plus its system dependencies.
- Viewer screenshots are uploaded when a run fails.
- A newer push cancels older runs of the same ref. The token is read-only.

Two checks were rewritten first, because they would have been flaky on a shared runner:
- **Perf tests run alone.** The three ~100k-vertex perf tests have absolute time bounds (1 s / 6 s / 15 s). Under the full parallel test run, one took 824 ms against its 1000 ms bound. That measured the scheduler, not the engine. They now run in a second vitest pass (`vitest.perf.config.ts`: no file parallelism, 120 s timeout) with the bounds unchanged. Locally they take 395 / 1159 / 2929 ms.
- **The worker responsiveness check is scale-free.** It used to assert "no main-thread task > 250 ms during the diff". A runner twice as slow could break that absolute number.
  - The app now publishes the diff's own timing window: epoch ms, measured where the diff ran (in the worker, or around the fallback call).
  - The check measures the longest stretch of that window the main thread spent inside one long task. It must be < 25% with the worker, and ≥ 75% with `?worker=0`, which proves the measurement sees blocking.
  - Locally: worker 0 ms of a 508 ms diff (0%); fallback 470 ms of 470 ms (100%).

**Verified on GitHub.** Before the first push, a fresh clone ran `npm ci && npm run verify` and passed in 1m18s. The first Actions run ([run #1](https://github.com/Joshua080/polymerge/actions/runs/36242458833)) was green in 1m34s end to end, 58 s of it for `npm run verify`.
- Perf tests on the runner: Tier 2 690 ms, Tier 3 1593 ms, against bounds of 6 s and 15 s.
- Worker: 0% of a 324 ms diff. Fallback: 100% of 281 ms.
- All 21 browser cases passed, plus e2e-view and e2e-git.

### Milestone 2 — Combined edits: decided **solvable now**, and fixed for a stated class ✅

**The gap.** Two edits that don't conflict under any rule, because they touch different vertices, edges, parts and frames, can still break the model once both are applied. Session 2 merged them silently.

**Decision.** The gap splits into two classes, and I treated them differently:
1. **Damage: solved now.** Surfaces passing through each other and faces folding over or collapsing are *objective* and *checkable*, and each one is attributable to specific edits. They are now a new conflict kind, **`collision`**.
2. **Design judgement: a stated v1 limit.** Coplanar contact, clearances, minimum wall thickness and design intent in general are *not* judged. Deciding whether two parts may touch, or how thin a wall may be, needs knowledge of intent that a mesh does not carry. This is written down in `docs/merge-design.md` §4.1, the README, and here.

**How it works** (`packages/core/src/merge/collide.ts`; details in the design doc):
- **Versions.** Each merged face gets a bit per version (base / ours / theirs): set when the face differs from that version or is missing there. Only geometry that differs from all three can be new damage. This also means a side's *own* self-intersection is never blamed on the merge.
- **Fold.** A face whose normal opposes every non-degenerate version of it, or that collapses below ε where none of its versions did.
- **Crossing.** A face pair that properly crosses (an edge passes through the other face, with ε margins on both endpoints) in "part space", where the same pair crosses in no version.
- **Regions.** A collision joins every change unit under its faces: both sides' change components at the corners, the added faces, and the frames of the parts involved. That needed two pieces of plumbing:
  - Region building now reruns (`buildRegions` / `addAtomics`).
  - A region can own a part *frame* even when the frame itself isn't in conflict.
- **Repeat until sound.** A region left at base can expose damage that its edits had hidden. For example, theirs dented a wall and lowered a block into the dent; reverting the dent leaves the block through the flat wall. So the check → re-region loop repeats until clean. The regression test takes 3 passes (18 crossings, then 16, then 0).
- **After resolution.** Picked resolutions can still combine badly. They are explicit choices, so they are not re-opened. They become `IMergeResult.warnings` instead: faces involved, and the conflicts that meet there. The CLI prints them. `polymerge git-merge --resolve` exits 1 on a warning, so git never auto-commits damaged geometry.
- **Opt-out:** `detectCollisions: false` in the API, `--no-collision-check` on the CLI.

**Tests.**
- `packages/core/test/merge/collision.test.ts`, 10 scenarios:
  - a thin wall pushed from both sides;
  - neighbours pushed past each other (fold);
  - two parts moved into the same space;
  - an addition pierced by the other side's edit;
  - the exposed-by-reversion case;
  - mixed resolutions → warning;
  - negative controls: near but not touching, and a side's own self-intersection;
  - symmetry;
  - the escape hatch.
  
  Each scenario checks that both sides are sound on their own and that each resolution gives back that side's geometry.
- CLI: 2 more tests. One covers the collision conflict in `merge` and `--no-collision-check`; the other covers the git driver stopping on a warning.
- The 25 existing merge tests are unchanged and all pass: no false positives on frame composition, additions or convergence.

**Cost.** A new perf test, `packages/core/test/merge/perf.test.ts`, covers 100k vertices / 198k faces. Ours moves a 50k-vertex part, and theirs makes 3000 local edits on it. The merge is clean, and the check adds about 25% (0.96 s → 1.2 s).
- On scattered edits over 99k faces it adds about 16%.
- Two optimisations got it there: bit tagging without per-vertex closures, and a BVH only over faces near the candidates.
- The final unresolved materialisation is also reused by `assemble`, instead of being computed twice.

| # | Decision | Why |
|---|----------|-----|
| D16 | Combined-edit *damage* (crossings, folds) is a conflict (`collision`); combined *design judgement* (contact, clearance, thickness) is not checked in v1. | Damage is objective and attributable to edits; the other judgements need intent the mesh does not carry. |
| D17 | Damage counts only when the geometry differs from all three versions (base, ours, theirs). | A side's own design, including its own self-intersections, is never blamed on the merge; it is also what makes the check cheap. |
| D18 | Damage created by *chosen* resolutions is a warning, not a new conflict; the git driver stops on it when resolving automatically. | Re-opening explicit choices would make resolution unstable; silently committing damage would be worse. |

### Milestone 3 — Merge review in the viewer: see conflicts, resolve by clicking ✅

Conflicts used to show only through the CLI and git. Visual review is the premise of the tool, so the viewer now has a **merge mode**.

**Opening it:**
- `polymerge view base ours theirs`: three files, where two open the diff.
- `polymerge review <path>`: reads git's index stages :1/:2/:3 during a conflicted `git merge`.
- `?mode=merge&base=…&ours=…&theirs=…`: URLs.
- Three drop zones.
- Five built-in examples, built in the browser from code (`?mode=merge&demo=…`): `thin-wall`, `boss-height`, `parts`, `mixed-choices`, `clean`.

**What you see.**
- The merged model is coloured by *who shaped each face*, with new `MERGE_COLORS` in core:
  - ours blue, theirs purple, the same change on both teal, untouched grey;
  - **unresolved conflict regions orange**, and they stay in the base state.
  
  These are deliberately disjoint from the diff's green / red / yellow: a merge is about provenance, not added/removed/moved.
- The provenance now counts part motions as "shaped by" their side. Before, a part moved by ours showed grey.
- The panel shows:
  - the merge status and what was auto-applied from each side;
  - one card per conflict: kinds, message, and **Ours / Theirs / Base** buttons;
  - "All …" buttons, collision warnings, downloads, and the equivalent CLI command.

**Resolving by clicking.**
- Click an orange region in 3D (the pick maps the merged face to its region through provenance), or its card. The region gets a white outline, and its three versions appear in place as outlines: ours blue, theirs purple, base grey (optional).
- Hovering a resolution button shows that version filled: a live preview of the choice.
- Buttons or keys `1`/`2`/`3` resolve, `0` undoes, and `n`/`p` step through conflicts.
- Each choice re-materialises the merge in the Web Worker without recomputing the diffs. The worker keeps the unresolved merge and receives the *complete* set of choices each time, which is what makes undo possible. The camera stays put.
- Choices that collide with each other show the core's collision warning.

**Finishing.**
- Download the result as STL/OBJ; unresolved regions are written in their base state, as the CLI does.
- Or copy the command: `polymerge merge … --pick 0=theirs`, plus `polymerge resolve <path> --pick …` when opened via `review`.

**Engine.** `DiffEngine` gained `merge()` / `resolve()` with the same worker / main-thread fallback. A superseded *resolve* is abandoned rather than killing the worker, because the worker holds the merge.

**Tests.**
- `scripts/e2e-merge.mjs` (in `npm run e2e`) runs the real CLI server with headless Chromium:
  - Three files open the merge review, and the merge runs in the worker.
  - Pixel classes show the orange region and the blue/purple automatic edits. Clicking "Theirs" turns orange (40 k px) into purple (47 k px); the command carries `--pick 0=theirs` and the resolve command for the repository path; the downloaded STL has theirs' boss height.
  - A **3D click on the region** selects it, and the key `1` resolves it.
  - Mixed choices raise a visible warning; "All ours" clears it.
- `scripts/e2e-git.mjs` now runs `polymerge review` inside a real conflicted merge and checks that the three stages are served.
- `apps/web/test/merge-review.test.ts` (7 tests): face classes unresolved and resolved, part-motion provenance, preview placement, and frame mapping.

Two bugs came up while writing the e2e, both fixed:
- Translucent ghost fills turned the orange region brown, which is unreadable. Ghosts are now outline-only, filled only on hover.
- Selecting a card on hover re-rendered the card list and swallowed the click. Selection now only toggles a class.

| # | Decision | Why |
|---|----------|-----|
| D19 | Merge review colours are provenance (ours / theirs / both / conflict), not diff status. | The question in a merge is *whose change is this*, and the diff colours would mean something else. |
| D20 | Every resolve re-materialises the unresolved merge with the complete set of choices, in the worker that holds it. | Undo and "change my mind" are free. Nothing drifts between the viewer and the CLI: the same `--pick` set gives the same model. |

### Milestone 4 — The 12-minute browser-test stall, investigated

**What the evidence says.** I reread the session-2 transcript at the moment of the stall:
- The previous case (`moved-part`) had printed PASS, so its context had closed.
- The stalled case (`units-inch-to-mm`) never wrote its first screenshot. So it hung between creating its context and that screenshot.
- In that stretch, `goto` (30 s default) and the ready-wait (120 s) have timeouts. Either would have *thrown* rather than hung.

That leaves five calls with **no timeout at all** in Playwright:
- `newContext` and `newPage`;
- the hook read (`page.evaluate`) and the examples read (`$$eval`);
- the two-frame wait, `requestAnimationFrame` ×2 inside `evaluate`.

Each of them waits forever if the renderer's main thread blocks, or, for the frame wait, if the page simply stops producing frames. Also, "12 minutes" was not a delay that resolved itself. It was how long it took me to notice and kill the run, so the hang was unbounded.

**Most likely mechanism.** WebGL here is software-rendered by SwiftShader inside one GPU process that every page shares; the process runs at ~165% CPU during the suite. three.js makes synchronous GL calls (parameter queries, shader and program status). If that GPU process wedges or starves, the renderer's main thread blocks on the next synchronous call and frames stop. From then on, every no-timeout call above waits forever. This fits all the evidence:
- it depended on what ran before, i.e. GPU-process state (the case passed in 0.8 s alone);
- it vanished on rerun;
- a browser relaunch, which starts a new GPU process, is the recovery.

**Changes (`apps/web/e2e/smoke.mjs`):**
- **Every browser call goes through `trace.step(name, …)`**, which records its name and duration. The per-case hard deadline now reports *which call is stuck and for how long*: `hung: … stuck in "read hook" for 149870 ms`. It also reports whether the browser is still connected and the steps completed so far. The next occurrence will name its cause instead of being a mystery.
- **The frame wait is bounded in the page** (two rAFs, or 3 s, whichever comes first). A page that stops producing frames can no longer hang that step; a blocked main thread is still caught by the deadline.
- **A context-wide default timeout** for every action that accepts one (screenshots, bounding boxes, waits), and a `crash` listener that fails the case with "renderer crashed" instead of letting it hang.
- **`--trace`** prints every step's timing per case plus a per-step summary (count / mean / max @ case). **`--repeat n`** reruns the target list n times, for stress runs.
- **`--simulate-hang <step>`** is a self-test of the deadline path: that step never finishes. Verified with `--simulate-hang frames`:
  - Each case failed at its deadline with `stuck in "frames" for 6692 ms (browser connected: true; steps done: newContext 13ms, newPage 119ms, goto 374ms, …)`.
  - The browser was relaunched, and the next case ran.
- The other browser suites (`e2e-view`, `e2e-worker`, `e2e-merge`) had the same unbounded calls. A hang there would have stalled CI until the 30-minute job timeout. They now use `scripts/watchdog.mjs`: fail within 3–5 minutes, name the stage, and kill the CLI server they spawned.

**Trying to reproduce it:**
- **Plain stress**, `smoke.mjs --trace --repeat 12`: 252 cases in one browser, no relaunch, 6m21s. **252/252 passed, no hang.** The slowest single call in the whole run was a 1.04 s screenshot; means are 7–364 ms per step. So there is no slow tail that grows into a hang, and no accumulation across 252 contexts in one browser.
- **CPU contention**: `--repeat 6` with four busy-loop processes pinning all 4 cores, 4m41s. **126/126 passed, no hang.** Screenshots slowed 2–3× (max 1.5 s); everything else barely moved.
- **Fault injection**: freeze the shared GPU process (SIGSTOP) the moment the hook read starts. This is exactly the stage where session 2 stalled: after "ready", before the first screenshot. The result reproduced the failure mode deterministically:
  - The hook read took 18 ms and the examples read 22 ms: **the page's JavaScript stays responsive**.
  - The two-frame wait took **3003 ms**: frames stopped, and it returned only through the new 3 s bound.
  - The screenshot hit its 20 s timeout. The error-path screenshot hung until the deadline, which reported `stuck in "screenshot (after error)"` and relaunched the browser. The next two cases passed in 0.9 s and 0.5 s.
  
  The old harness waited for two frames with no bound at that exact point, so it would have waited forever: the session-2 symptom.

- **Permanent freeze** (nobody unfreezes the GPU process): the case fails at its deadline, naming the step. `browser.close()` cannot finish, so after 5 s the harness kills the stuck browser's whole process group (Playwright starts each browser in its own group) and relaunches. The next case passed, and nothing was left running. Before this, a stuck browser would have lingered for the rest of the run.

**Conclusion.** The mechanism is identified and reproduced on demand. When Chromium's shared GPU process stalls (SwiftShader, headless), the page stops producing frames while its JavaScript stays alive. The harness's unbounded frame wait turned that into an infinite hang. *Why* the GPU process stalled once is inside Chromium/SwiftShader and did not recur in 378 stressed runs; it is not in polymerge's code. The harness now:
- bounds that wait and every action;
- names the stuck call if anything still hangs;
- recovers with a fresh browser, which means a fresh GPU process.

A hung case is still reported as a failure, never retried silently: an infrastructure stall should be seen, not hidden.

| # | Decision | Why |
|---|----------|-----|
| D21 | Every browser wait in the e2e suites is bounded, and a hang names its step and discards the browser (process-group kill). Hangs fail the run and are never retried. | The session-2 stall was a Chromium GPU-process stall turned into an infinite hang by one unbounded frame wait. Fault injection shows the new harness diagnoses and recovers from exactly that. |

### State at end of session 3

**Verified.** `npm run verify` is green locally and on GitHub Actions for every push of this session, in about 1.5 min. It covers:
- typecheck;
- 458 unit / fixture / merge / web tests;
- 4 perf tests;
- build;
- smoke (21 browser cases), e2e-view, e2e-worker, e2e-merge and e2e-git.

**Known limits / next steps**
1. **Collision check scope (v1, by decision):** coplanar contact, clearances, wall thickness and design intent are not judged (D16).
2. **Deformation transfer for `lineage` conflicts:** apply an edit made on one tessellation to a remeshed other side. Carried over.
3. **Saving from the merge review:** the viewer downloads the result or gives the exact command. A `polymerge review` session could write the file back and `git add` it directly. That needs a write endpoint on the local server, so it deserves its own security look (token, 127.0.0.1 only).
4. **GLB/glTF writer**, and merging materials/UVs. Carried over.
5. **Parsing in the worker**, and chunked scene building for very large results. Carried over.
6. **Z-up models:** the viewer's default camera assumes Y-up, so CAD/print models (Z-up) open side-on. A per-model "up" choice would help merge review too.
7. npm publishing. Carried over (done in session 4, except the publish itself).

---

## Session 2 — 2026-09-26 — correspondence fixes, then three-way merge

Priorities set by the owner: (1) fix the two known correspondence bugs, with regression tests that would have caught them; (2) design and start three-way merge; (3) if time allows, move the browser diff into a Web Worker.

Work happens on `claude/optimistic-franklin-u4oplc`, branched from `main`, with a PR into `main`.

### Milestone 1 — Regression tests first (both bugs reproduced) ✅

I wrote the tests before touching the engine, and all of them failed on the session-1 engine:

- `packages/core/test/diff/parts.test.ts`: 8 scenarios.
  - A small part rotated and moved while the file order is shuffled.
  - A 50/50 two-part model where one half moved.
  - Direct lineage.
  - A whole-model Tier 3 move plus one part moved relative to it.
  - Four identical parts with one moved.
  - A moved part that was also edited locally.
  - Two negative controls: a different part added, and an unchanged model.
- `packages/core/test/diff/scale.test.ts`: 8 scenarios.
  - in→mm with rotation, mm→in, m→mm, and a non-unit ×1.5.
  - Units plus a real local edit.
  - Same-lineage unit re-export.
  - Whole-model translation.
  - Scale must stay exactly 1 on a remesh.
- Real symptoms measured on the session-1 engine:
  - The knob in the assembly test: 0 moved; its 62 vertices read as removed + added.
  - inch→mm with rotation: Tier 3 reported **481 of 482 vertices "added"**, none unchanged.
  - The same file re-exported ×25.4: all 482 vertices "moved".
- File-based fixtures: `moved-part` (OBJ↔OBJ), `units-inch-to-mm` (STL inches ↔ OBJ mm, rotated and shuffled) and `units-same-lineage` (STL↔STL). Run in a worktree of `main` against the **session-1 engine**, these three cases fail **13 checks**: tier, vertex/face counts, `mustMatch` correspondences and the alignment.

### Milestone 2 — Moved parts are MOVED, not removed + added ✅

New modules: `diff/components.ts` (connected components by union-find), `diff/parts.ts`, `diff/propagate.ts` (Tier 2's propagation extracted into a reusable class) and `diff/alignment.ts` (Tier 3's ICP extracted into a reusable estimator).

- **Recovery:** components that the accepted matching leaves mostly unmatched are rigidly registered pairwise, with ICP on the two components.
  - Candidate pairs must be isolated: whatever is matched in B maps only into T, and vice versa. Their vertex counts must be within ×3 and their RMS radii within ×1.5.
  - Candidates are ranked by shape similarity, then by least motion, 3 per component, with at most 64 registrations per diff.
  - **Tiers 1/2:** seeds come from mutual nearest neighbours under the part transform. Propagation then grows them, so vertices edited locally on the moved part are matched too.
  - **Tier 3:** nearest-surface mapping runs under the part transform.
  - A pair is accepted only when `gain ≥ max(3, 10% of the part)` and it explains ≥ 50% of the part. Accepted pairs are applied greedily (largest gain first, then least motion), and each component is used once.
- **Where it runs:**
  - Tier 2: inside the tier, before scoring, so a big moved part no longer pushes Tier 2 below its threshold.
  - Tier 3: after the global alignment.
  - Tier 1: as a post-pass.
- **Matched-part analysis (Tiers 1/2):** already-matched parts that mostly moved are fitted with one trimmed rigid motion. The motion is reported when ≥ 90% of the part's pairs follow it.
- **Contract:** new `IDiffResult.parts: IPartMotion[]`. Each record has the source (`registration` | `matched`), vertex lists, matched/deformed counts, the full transform, rotation, centroid shift relative to the alignment, rms, and group names. It can be switched off with `detectParts: false`. Every part gets an explicit log line: `[polymerge] ↳ moved part …`.
- **Honest limits:**
  - A part deleted at one place and an *identical* copy added elsewhere is indistinguishable from a move, so it is reported as one.
  - A part that is part of a connected mesh, i.e. a region dragged far from its neighbours, is still matched by propagation only within ~3 edge lengths.

### Milestone 3 — Uniform scale / unit mismatch ✅

- **`linalg.ts`:** transforms are now similarities, `x ↦ s·R·x + t`. Horn's solver takes a free (Umeyama) or fixed scale, and the point-to-plane step has a 7-unknown variant with scale.
- **`alignment.ts`, scale hypotheses:**
  - The area-weighted moment ratio `s0 = √(tr Σ_target / tr Σ_base)` is exact for a scaled copy and independent of tessellation. It becomes a hypothesis when `|s0 − 1| > 1.5%`.
  - If s0 is within 0.5% of a unit factor it is replaced by that factor. Otherwise the nearest unit factor within ×1.25 is added as a third hypothesis.
  - Scaled guesses re-estimate the scale during ICP, clamped to ×1.5 of their hypothesis.
  - Guesses are ranked by a **symmetric** trimmed surface distance, because a one-sided score rewards shrinking the base into a corner of the target.
  - Least motion still wins among comparable fits, so an equally good rigid fit beats a scaled one.
- **Snapping (`units.ts`):** a fitted scale within 0.5% of a factor between mm/cm/m/in/ft is snapped exactly and labelled in `alignment.units`, e.g. `{from:'in', to:'mm', factor:25.4}`. A scale within 1.5% of 1 becomes 1, because small scales such as shrink compensation are real edits that should read as moves and faceting noise must never become a fake scale. Rotation and translation are re-refined with the scale fixed.
- **Tier 3 mapping:** base-space surface distances are multiplied by the scale.
- **Global transform (`global.ts`, Tiers 1/2):** when one rigid or similarity motion explains ≥ 90% of matched pairs, it becomes the `alignment`. The same lineage re-exported in mm now reads as Tier 1 + "in → mm", all unchanged, instead of N moved vertices. It exits early when the identity already explains more than 50% of pairs. It can be switched off with `detectGlobalTransform: false`.
- **Contract:**
  - `IRigidTransform` gains `scale` and `units?`, and is documented as a similarity. Its semantics changed: Tiers 1/2 alignment is no longer always the identity (this supersedes D3's "identity for Tiers 1/2").
  - `IDiffOptions` gains `detectScale`, `detectGlobalTransform` and `detectParts`.
  - Serialisation handles `parts`, and older JSON is upgraded on read (`parts: []`, `scale: 1`).
- **CLI and viewer:**
  - The CLI report shows units or scale, a "Moved parts" list, and `decomposeRigid` now separates the scale.
  - The viewer's alignment panel shows Units, is titled "Global transform" for Tiers 1/2, gains a Moved parts list, and rounds float32 noise to 0 for display.

**Decisions**

| # | Decision | Why |
|---|----------|-----|
| D9 | Moved parts are recovered by registering whole connected components, and a registration is accepted only when it explains clearly more than the current matching. | "Maximise explained vertices, then minimise motion": this never replaces a good matching with a speculative one, and it handles coincidental seeds (a part moved by exactly its own width). |
| D10 | Uniform scale is modelled only when the moment ratio deviates by more than 1.5%, and snapped when within 0.5% of a length-unit factor. | Unit mismatch is the real-world case, and unit factors are far apart. Tiny scales are ambiguous with faceting, and treating them as moves keeps real edits visible. |
| D11 | A whole-model motion in Tiers 1/2 is reported as one global alignment (when it explains ≥ 90% of the matched vertices). | "All 50,000 vertices moved" hides the actual story. This also matters for merge: a unit re-export on one side must not conflict with every local edit on the other. |

**Verification:** `npm run typecheck` is clean. `npm test` passes **406** tests; the 100 skips are per-case `runIf` gates. The build succeeds. `npm run e2e` passes **21/21** browser cases plus the CLI → browser check. At 100k vertices (warm), Tier 1 takes ≈ 0.28 s and Tier 2 ≈ 0.9 s, about 10% more than before because of the component bookkeeping; Tier 3 takes ≈ 2.5 s.

### Milestone 4 — Three-way merge: design ✅

Written up in **`docs/merge-design.md`** before any code. The key conclusions:

- **Text-merge rules do not transfer.**
  - A vertex is a surface *sample*, so adjacent edits must **not** conflict by themselves.
  - Frames (a whole-model move, a unit re-export, a moved part) change every coordinate without changing the design locally.
- **Frames + residuals.** Each side is decomposed into atomic edits against the base:
  - a global frame `T_S` and per-part frames `R_S,c`;
  - a local residual per vertex, expressed in the **base frame**: `δ_S(v) = Φ_S(v)⁻¹(p_S) − p_O`;
  - vertex and face deletions;
  - additions, each anchored to base vertices or floating.
  
  Frames and residuals are merged independently with the classic three-way rule (unchanged → take the other; equal → convergent; else conflict). The merged position is `Φ_M(v)(p_O + δ_M)`. So "ours converted to mm, theirs moved a vertex" and "ours moved a part, theirs edited it" compose instead of conflicting.
- **Unit conversions compose last.** A pure unit conversion is a change of *representation*, not design, so it composes with the other side's whole-model move (`U ∘ T`) instead of conflicting.
- **Eight conflict kinds:** `move-move`, `move-delete`, `delete-dependency`, `competing-additions` (same edge; also catches both sides re-meshing a region differently), `overlapping-additions` (interpenetrating new geometry), `part-motion`, `global-transform` and `lineage` (Tier 3 remesh: no vertex identity).
- **Deliberately not conflicts:** adjacent vertex edits; a hole on one side with a rim vertex moved on the other; re-triangulation on one side with a vertex moved on the other; convergent changes; additions that share only one anchor vertex.
- **Regions are the unit of resolution** (the analogue of a conflict hunk). A region is the union of *whole* change components of both sides that touch an atomic conflict, closed under overlap, so resolving never half-applies an edit. The choices are `ours` / `theirs` / `base`. **Unresolved regions keep the base state**; the merge never guesses.

### Milestone 5 — Three-way merge: implementation ✅

`packages/core/src/merge/`:
- `sides.ts`: the decomposition above. A Tier 3 side is usable only when its correspondence is one-to-one and preserves every face; otherwise the result is a `lineage` conflict.
- `plan.ts`: frame decisions, atomic conflicts, convergent-addition unification (mutual nearest within ε, in the base frame), competing edges, and regions by union-find over the change components of both sides.
- `overlap.ts`: interpenetration tests between additions. They use edge-crosses-triangle (Möller–Trumbore) plus vertex-touches-triangle tests, compared in the base frame, with a uniform grid to stay near-linear.
- `materialize.ts`: the merged mesh (orphaned vertices dropped), provenance for every vertex and face, and statistics.
- `index.ts`: `mergeMeshes(base, ours, theirs, opts)` and `resolveMerge(result, {id: side})`, which re-resolves without recomputing the diffs.

Supporting changes:
- **Writers** (`packages/core/src/writers/`): OBJ (keeps groups) and STL (binary/ASCII). Each number is the shortest decimal that round-trips through float32. GLB output is not supported yet.
- **CLI:**
  - `polymerge merge <base> <ours> <theirs> -o out.stl|obj [--resolve side] [--pick id=side] [--report x.json]` exits 1 while conflicts are unresolved.
  - `polymerge git-merge %O %A %B %P` is the git merge driver. It writes the result over %A and exits 1 on conflicts, so git marks the file `UU`.
  - `polymerge resolve <path> --pick 0=theirs` reads git's index stages :1/:2/:3 to finish a conflicted merge.
  - `git-setup` prints the `merge=polymerge` attributes and the driver config.
- **Contract:** `IMergeResult`, `IMergeConflict`, `IMergeStats`, `IMergeProvenance`, `IMergeOptions`, `MergeConflictKind` and `MergeResolution` are in `types.ts`.

Tests:
- `packages/core/test/merge/merge.test.ts`: 25 scenarios.
  - Clean merges: disjoint edits, adjacent edits, convergent moves/deletes/additions, a hole plus a rim move, additions on different edges, a re-ordered (Tier 2) side, and an orphan vertex.
  - Frame composition: part motion + local edit, unit conversion + local edit, both converted, and unit conversion + whole-model move.
  - Every conflict kind, with resolution and base-state checks.
  - Symmetry (ours ↔ theirs), identities (merge with base or self), and logging.
- `writers.test.ts` (6) and `packages/cli/test/merge.test.ts` (5) run in-process with real files.
- `scripts/e2e-git.mjs` runs with **real git** and is part of `npm run e2e`: diff driver, a clean `git merge`, a conflicting `git merge` (UU, base kept in the region, other edits merged), then `polymerge resolve` + `git add` + commit.

**Decisions**

| # | Decision | Why |
|---|----------|-----|
| D12 | Merge = frames (global, per part) + base-frame residuals, merged independently. | It removes the false conflicts a per-vertex comparison would produce for unit re-exports, whole-model moves and moved parts. |
| D13 | Adjacent vertex edits do not conflict; conflicts need the *same* vertex, anchor edge, part, frame or space. | Mesh vertices are samples, not semantic lines. Composition side effects such as intersections are a separate, future check. |
| D14 | Conflict regions are unions of whole change components; unresolved regions stay at the base state. | Resolving never half-applies an edit, and the tool never guesses (owner's requirement). Git sees a conflicted file. |
| D15 | A Tier 3 side with retessellation is a whole-model `lineage` conflict. | Vertex-level merging needs vertex identity. Transferring edits across tessellations is future work. |

### Milestone 6 — Diff in a Web Worker ✅

- `apps/web/src/engine.ts` (`DiffEngine`) runs `diffMeshes` in one persistent **module worker** (`src/worker/diff.worker.ts`, protocol in `src/worker/protocol.ts`).
  - Meshes are structured-cloned in. The result's typed arrays are **transferred** back without copying.
  - Engine log lines stream to the main thread, so the browser console still names the tier and the loading overlay shows each tier attempt live.
  - A newer diff supersedes a running one by terminating the busy worker.
  - The engine falls back to the main thread when workers are unavailable or fail to load. `?worker=0` forces the fallback.
- The worker bundle is 59 kB. Tree-shaking keeps three.js out of it; it holds the diff engine only.
- The test hook exposes `engine: 'worker' | 'main'` and `parts`. The smoke test now fails if a real diff didn't run in the worker.
- **Evidence:** `scripts/e2e-worker.mjs` is part of `npm run e2e`. It uses a 40k-vertex pair, re-indexed so Tier 2 has real work.

  | Mode | Longest main-thread task during the diff | Frames rendered |
  |---|---|---|
  | Worker | 143 ms (building the scene from the result) | 35 |
  | `?worker=0` | 513 ms (the diff itself) | 7 |

  The check measures main-thread **long tasks**, not raw frame gaps. Headless Chromium rasterises WebGL in software (SwiftShader), so one frame of a freshly loaded 80k-triangle model took ~330 ms with *no* JavaScript running. The long-task observer showed this, and it would not happen on a real GPU.
- Still on the main thread: parsing files (~100 ms at 80k triangles) and building three.js buffers from the result (~100–150 ms). Moving parsing into the worker is the next step.

### Test infrastructure fix

During one full `npm run e2e` run, headless Chromium stalled on one case for 12 minutes. That case passed in 0.8 s on its own, and so did a full rerun (21/21). The per-case Playwright timeouts did not fire, because a browser call hung outside them. `apps/web/e2e/smoke.mjs` now gives each case a **hard deadline** (timeout + 30 s). A stalled case fails loudly as `hung: …`, and the browser is relaunched for the remaining cases. Hangs are reported, never silently retried.

### State at end of session 2

**Verified** (full `npm run verify` — see the commit): typecheck clean; all unit, fixture and merge tests pass; build OK; `npm run e2e` passes. That covers 21/21 browser cases, CLI → browser, the worker responsiveness check, and real-git diff/merge/resolve.

**Known limits / next steps**
1. **Merge UX in the viewer:** show merge results and conflict regions, and pick ours/theirs per region with a click. Today it is CLI and git only.
2. **`collision` conflicts:** independent edits whose *composition* intersects or flips faces (design §4). Today this is only detected between additions.
3. **Deformation transfer for `lineage` conflicts:** apply an edit made on one tessellation to a remeshed other side.
4. **GLB/glTF writer**, so merges can output GLB. Materials/UVs are not merged yet.
5. **Parsing in the worker.** Chunked scene building for very large results.
6. **Merge performance:** the plan builds adjacency/components on top of two full diffs. It is fine at the tested sizes (≤ 10k vertices in tests) but has not been profiled at 100k+.
7. Carried over from session 1: CI (GitHub Actions running `npm run verify`), npm publishing, and the small contract follow-ups.

---

## Session 1 — 2026-09-25 — v1 MVP: end-to-end pipeline

### Milestone 0 — Plan & contract (orchestrator)

**Architecture**

```
packages/core   @polymerge/core  isomorphic (Node + browser), no fs/DOM
  src/types.ts        shared type contract (IMesh, IVertex, IDiffResult, ...) — orchestrator-owned
  src/mesh.ts         createMesh / getVertex / getFace / describeVertexChange helpers
  src/parsers/        STL / OBJ / glTF+GLB → IMesh via three.js loaders + welding
  src/diff/           tiered correspondence engine (Tier 1 → 2 → 3) + JSON serialisation
packages/cli    @polymerge/cli   `polymerge diff | view | info | git-diff`
apps/web        @polymerge/web   Vite + Three.js viewer (OrbitControls, strict colour legend)
fixtures/                        generator + known-answer model pairs + e2e tests
```

**Decisions**

| # | Decision | Why |
|---|----------|-----|
| D1 | One normalised `IMesh`: welded float64 vertex pool + `Uint32Array` triangles + groups/materials/metadata. | The diff engine never branches on source format. |
| D2 | Welding = exact float32 equality, indices in **first-appearance order of the triangle stream**. | STL has no shared vertices and three's OBJLoader de-indexes, so real index identity is gone. A deterministic weld order restores a stable "index" that is identical across STL/OBJ/GLB for the same face order, which is what makes Tier 1 viable. |
| D3 | Diff results live in **target space**; `alignment` (base→target rigid transform) is the identity for Tiers 1/2 and the ICP solution for Tier 3. | One coordinate frame for the viewer and for status thresholds. |
| D4 | Bulk per-vertex/per-face data in typed arrays; `IVertex`/`IFace`/`IVertexChange` are object *views* for UI/reporting. | Scales to 100k+ vertex meshes without per-vertex objects. |
| D5 | Canonical colours are exported from core (`DIFF_COLORS`): added `#22c55e`, removed `#ef4444`, moved/modified `#facc15`, unchanged `#9ca3af`. | Single source of truth for the viewer, CLI and docs. |
| D6 | The engine always logs each tier attempt and the accepted tier (default sink `console`). | Hard requirement: every diff states which tier fired. |
| D7 | The viewer consumes core **from source** through a Vite alias; the CLI consumes the built `dist`. | No build step needed for web dev; a real `bin` for the CLI. |
| D8 | Nothing is pushed to a remote this session. | Owner's instruction: local verification first. Lifted once verification passed (Milestone 7). |

**Environment findings**
- three@0.186.1 loaders run under Node 22: STL ✔, OBJ ✔, GLB ✔ (custom attribute `_VERTEX_ID` surfaces as `_vertex_id`).
- JSON `.gltf` with data-URI buffers fails under Node (`ProgressEvent is not defined`, via FileLoader/fetch); it needs a workaround in the parser.

**Subagent split (run in parallel, disjoint file ownership)**
1. Parsers & Normalisers → `packages/core/src/parsers/**`, `packages/core/test/parsers/**`
2. Core Diff Engine → `packages/core/src/diff/**`, `packages/core/test/diff/**`
3. Front-end Visualiser → `apps/web/**`
4. Test Fixtures → `fixtures/**` (generator, cases, manifest, e2e tests)
Orchestrator: types, mesh helpers, CLI, root config, docs, integration.

### Milestone 1 — CLI + git integration (orchestrator, in parallel with the agents)

`packages/cli` (`polymerge` bin, built with tsc against core's `dist`):

- `polymerge diff <base> <target>`: colour report (tier attempts, vertex/face counts, displacement, alignment, largest vertex moves). `--json <file|->` writes the serialised `IDiffResult`, `--force-tier`, `--move-eps`, `--surface-tol`, `--exit-code`. Engine logs go to **stderr**, so stdout stays pipeable.
- `polymerge view <base> <target>`: tiny `node:http` server that serves `apps/web/dist` and the two models at `/models/{base,target}/<name>`. It opens `/?base=…&target=…` in the browser. Model bytes are read up front so `git difftool` temp files may vanish.
- `polymerge info <file>`: normalised mesh summary (welded vs loader counts, groups, materials, warnings).
- `polymerge git-diff`: **GIT_EXTERNAL_DIFF driver** (`diff.polymerge.command`). Handles new/deleted files (`/dev/null`) and renames (9-arg form). It uses the repo path for format detection because git's temp files may be named arbitrarily. It always exits 0, since git aborts on non-zero, and falls back to "Binary files … differ" when it can't parse.
- `polymerge git-setup`: prints the `.gitattributes` + `git config` snippet (it does not modify any config itself).

### Milestone 2 — Parsers & normalisers (agent 1) ✅

- `packages/core/src/parsers/`: `detect.ts`, `bytes.ts`, `weld.ts` (`buildWeldedMesh`: format-agnostic triangle soup → `IMesh`), `stl.ts`, `obj.ts`, `gltf.ts`, `gltf-container.ts`, `three-mesh.ts`, `index.ts` (`detectFormat`, `loadMesh`).
- **Exact weld** keys on the float32 bit patterns (-0 → +0) in a custom open-addressing hash, with no string keys. A second renumbering pass after degenerate removal keeps indices in first-appearance order among *kept* triangles. A 1M-triangle STL welds in about 0.3 s.
- **Epsilon weld** uses a grid with 2ε cells and a 2×2×2 probe. Each corner merges into the earliest vertex within ε, measured to that vertex's first position. This is not transitive: in a chain A–B–C, C may stay separate.
- **glTF**: every `.gltf`/`.glb` is repacked into one in-memory GLB before GLTFLoader sees it. That fixes data-URI `.gltf` under Node without touching globals.
  - External URIs throw `MeshLoadError`. Images, textures and samplers are stripped, with one warning.
  - If Draco or meshopt is *required* the loader throws. If either is optional, the fallback data is used.
  - Skinned meshes, morph default weights and instancing are baked. Materials are de-duplicated per glTF material index.
- **STL**: binary facet colours become `materials` + `faceMaterials`. Truncated or undersized files, and binary files whose header starts with "solid", are pre-validated before three sees them.
- 85 tests: exact weld order, cross-format identity (ASCII/binary STL, OBJ, GLB, .gltf give identical arrays), transform baking, ids, degenerates, sniffing, errors and `weldEpsilon`.

### Milestone 3 — Core diff engine (agent 2) ✅

`packages/core/src/diff/`: `engine.ts` (tier chain + mandatory logging), `tier1.ts`, `tier2.ts`, `tier3.ts`, `classify.ts`, `adjacency.ts` (CSR), `faceset.ts`, `spatial.ts` (kd-tree, triangle BVH), `linalg.ts` (Horn quaternion + 4×4 Jacobi), `heap.ts`, `prng.ts`, `serialize.ts`.

| Tier | Score | Threshold | Notes |
|---|---|---|---|
| 1 | `min(faceAgreement, matchedFraction)`, both over the **smaller** mesh | 0.95 | See T1 below |
| 2 | `coverage × edgeConsistency`, where `coverage = (matched − slid) / (min(nB,nT) + onSurfaceUnmatched)` | 0.60 | See T2 below |
| 3 | inlier fraction (within `surfaceTolerance`) | terminal | See T3 below |

- **T1 — index/ID.**
  - ID mode runs when both sides have ≥ 50% `vertexIds`; otherwise index mode `i ↔ i`.
  - *Orphan rule:* a pair is un-matched (removed + added) when the vertex has faces but none of them is preserved.
  - Result: any move, appended geometry or end-trim scores 1; shuffled or unrelated meshes score about 0.
- **T2 — MeshGit-inspired.**
  - Seeds are *unambiguous* mutual nearest neighbours within `moveEpsilon`.
  - Growth is greedy from a min-heap, with cost `g/√a + 2(1 − J)` and cutoff 3.
    - a = number of agreeing matched neighbours.
    - J = Jaccard agreement of the two matched neighbourhoods.
    - g = residual after following the neighbours' mean displacement, over the local edge length.
  - A *face-support gate* stops growth across a foreign tessellation.
  - "slid" (a match that moved along the old surface) and "on-surface unmatched" are evidence of retessellation. That is what now pushes `remesh` down to Tier 3: it scores 0.248 there, versus 0.97–1.0 on real topology edits.
- **T3 — ICP.**
  - Initial guesses: identity, centroid, and det=+1 PCA frames (all 24 axis permutations when two moments are within 10%).
  - A trimmed point-to-point coarse stage, then Horn refinement and a point-to-plane polish. The least-motion fit within 1.25× of the best residual wins, so an unmoved remesh reports the identity.
  - Mapping uses exact point-to-triangle distance (BVH) plus the nearest vertex (kd-tree).
- **Timings (100k vertices, Node):** Tier 1 ≈ 0.2 s; chain to Tier 2 ≈ 0.75 s; chain to Tier 3 ≈ 1.85 s.
- **Tests:** 55.
- **Contract clarifications** applied to `types.ts` on the agent's recommendation:
  - Tier 3 `baseToTarget` semantics;
  - `stats` matched counts are target-side;
  - `rmsError` may be > 0 for Tier 3 even when the fit is the identity.

### Milestone 4 — Web visualiser (agent 3) ✅

- `apps/web/`: `src/app.ts` (controller), `scene/viewer.ts`, `scene/layers.ts`, `panels.ts`, `sources.ts`, `hook.ts`, `dev/mock.ts`, `style.css`, and a `vite.config.ts` fixtures plugin. The plugin serves `/fixtures/*` in dev and preview with a traversal guard, and copies the fixtures into `dist/` on build.
- **Rendering:** the target is drawn non-indexed with per-face `DIFF_COLORS`. Removed base faces are drawn in red after being moved into target space by `alignment`.
- **Layer toggles:** base ghost, unchanged faces, vertex markers, displacement vectors, wireframe.
- **Panels and inspection:**
  - The tier badge and attempt log, plus counts and alignment.
  - **Click-to-inspect** uses `describeVertexChange`: *base #i → target #j, from/to/Δ/distance*. There is also an inspector for looking up a vertex by index.
- **Loading:**
  - Drag-and-drop or file pickers.
  - An examples dropdown built from the fixture manifest.
  - URL parameters: `?base=&target=`, `?case=`, `?tier=`, `?mock=1`.
  - A "Download diff JSON" button.
- **Test hook:** `window.__POLYMERGE__` plus `body[data-state]`.
- **Smoke test:** `apps/web/e2e/smoke.mjs` uses Playwright and SwiftShader WebGL. It checks the hook, that the canvas is not blank, which diff hues are present, and click-to-inspect.

### Milestone 5 — Test fixtures (agent 4) ✅

- `fixtures/generate.ts` plus `fixtures/lib/`: builders, independent writers for STL (ASCII and binary), OBJ, GLB and data-URI .gltf, and a reference welder. The generator is deterministic and byte-stable.
- **18 cases**, 37 files, 154 KB. See `fixtures/README.md`. They cover:
  - Tier 1: identical, moved corner, grid bump, cross-format (STL↔OBJ, OBJ↔GLB, .gltf↔GLB), `_VERTEX_ID` with a shuffle, multi-node transforms, node hierarchy, multi-part OBJ↔GLB, degenerates, appended geometry.
  - Tier 2: removed patch, shuffled faces, mixed topology edit.
  - Tier 3: rigid 30° about (1,2,2) + translation; cylinder remesh 24→32 segments; box remesh.
- **Expectations** are derived by a reference model of the normalisation contract and cross-checked against hand-derived numbers.
- `selfcheck.test.ts` validates the files with the stock three.js loaders only, without any polymerge code. `e2e.test.ts` asserts sizes, tier, counts, `mustMatch` pairs, alignment, invariants, and that a log line names the tier.

### Milestone 6 — Integration & verification (orchestrator) ✅

| Check | Result |
|---|---|
| `npm run typecheck` (core, core tests + fixtures, cli, web) | clean |
| `npm test` (vitest) | **347 passed**, 73 skipped (all skips are per-case `runIf` gates, e.g. alignment checks only on rigid cases) |
| `npm run build` (core → cli → web) | OK (web bundle 750 kB: three.js, not yet code-split) |
| `node apps/web/e2e/smoke.mjs` (real core, headless Chromium + SwiftShader) | **18/18 cases pass**, including click-to-inspect |
| `node scripts/e2e-view.mjs` (`polymerge view` → local server → browser → real diff → render) | PASS, and the tier line appears in the *browser* console |
| git driver in a scratch repo (`diff=polymerge` + `diff.polymerge.command`) | `git diff part.obj` prints the structural report, e.g. Tier 2 · *base #29 → target #77 Δ(0,0,0.25)*; new-file path verified |

The integration fix went back to its owner: fixtures + parsers exposed `remesh` being accepted by Tier 2. The diagnosis was relayed to the diff agent, which added the retessellation evidence (slid / on-surface) to the Tier 2 score.

### Milestone 7 — Published to GitHub ✅

- Local verification passed from a fresh clone (`npm install && npm run verify`), and the owner then approved publishing.
- The work is now on **`main`** at `github.com/Joshua080/polymerge`. It was renamed from the session branch `claude/optimistic-franklin-u4oplc`, so the history is unchanged.
- The LICENSE copyright holder is Joshua Hurley.
- No PR yet. PRs start with the next feature branch, compared against `main`.

### State at end of session 1

**Fully operational**
- Load STL (ASCII/binary), OBJ, GLB and data-URI .gltf in Node and the browser → a single welded `IMesh`.
- Tiered correspondence 1 → 2 → 3, with every attempt and the accepted tier logged to the console.
- CLI: `diff` (report / JSON / exit code), `view`, `info`, `git-diff` (external diff driver), `git-setup`.
- Browser viewer with strict colour coding, orbit/zoom, layers and vertex-level inspection.
- Deterministic known-answer fixtures, plus unit, e2e and browser smoke suites.

**Stubbed / mocked / not yet built**
- **Three-way merge** is not started. The architecture is ready for it: one correspondence per side against a common base.
- `?mock=1` in the viewer is a dev-only mock. The real path never uses it.
- The diff runs on the browser main thread; there is no Web Worker yet.
- `.gltf` with external `.bin`/image URIs is not supported (throws `MeshLoadError`). Draco and meshopt are not supported. Textures are ignored.

**Known issues / limitations**
- A deletion near the *end* of the face stream can still pass Tier 1, with the shifted tail reported as removed + added.
- Tier 2 cannot seed a component that was rigidly moved *on its own*; it shows as removed + added.
- A regular lattice shifted by exactly one period mis-seeds.
- Tier 3 is rigid only: no scale (mm↔inch) and no per-part motion. Symmetric shapes report their least-motion equivalent. Tier 3 correspondences can be many-to-one.
- The epsilon weld is not transitive.
- OBJLoader turns any object that contains an `l` line into lines, so that object's faces are skipped, with a warning.
- Only the default glTF scene is loaded.
- Viewer:
  - Removed faces that sit off the target surface are drawn over it; toggle the layer to see what is underneath.
  - Markers and vectors switch off by default above 1.5k / 5k elements.
  - The web bundle is not code-split.
- three.js prints its own console warnings on malformed files; they are not suppressed.

**Next steps (session 2)**
1. **Three-way merge MVP**:
   - diff(base→ours) and diff(base→theirs);
   - vertex-level conflict detection (the same base vertex moved differently, or edited on one side and deleted on the other);
   - an auto-merge of non-conflicting edits;
   - `merge.polymerge.driver` for git;
   - a conflict view in the viewer.
2. Move `diffMeshes` into a Web Worker, and add a side-by-side / slider compare mode.
3. Tier 2: per-component rigid seeding, via ICP on unmatched components, so separately moved parts stay "moved".
4. Tier 3: optional uniform scale (unit-mismatch detection).
5. CI (GitHub Actions running `npm run verify`), and npm publishing of `@polymerge/core` and `@polymerge/cli`.
6. Small contract follow-ups: promote `extras.invalidFacesDropped` to a metadata field, and decide whether to export `buildWeldedMesh` publicly.
