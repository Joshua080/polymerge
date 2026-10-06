# Contributing to polymerge

Thanks for helping. Bug reports, model files that polymerge gets wrong, documentation fixes and code are all welcome.

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md). Security problems go to the private report described in [SECURITY.md](SECURITY.md), not to a public issue.

## Reporting a problem

Open an issue with the **Bug report** form. The most useful thing you can attach is a model that shows the problem. A small one is best: two versions of a cube with the edit that goes wrong beat a 50 MB scan.

- **Don't attach models you aren't allowed to share.** Issues are public.
- For the viewer, the **Engine log** section (at the bottom of the panel) and the browser console say what the engine decided and why.
- `polymerge diff a b --json out.json` writes the full result, if you want to attach it.

## Setting up

You need Node.js 20 or newer and git.

```bash
git clone https://github.com/Joshua080/polymerge.git && cd polymerge
npm install
npm run build                            # core → CLI → web viewer
npx playwright install chromium          # once: the end-to-end checks use headless Chromium
npm test                                 # unit, fixture and merge tests, then the perf tests
npm run e2e                              # real browser, real git, the Action, a packed npm install
npm run verify                           # everything CI runs: typecheck, tests, build, e2e
```

Useful while working:
- `npm run dev`: the viewer with live reload and the built-in examples.
- `npm run polymerge -- diff a.stl b.stl`: the CLI from this checkout.
- `npm link -w @joshuahurley/polymerge`: puts this checkout's `polymerge` on your PATH.

The [README's Development section](README.md#development) maps the repository: `packages/core` (the engine), `packages/cli`, `apps/web` (the viewer), `action/` (the GitHub Action), `fixtures/`, `scripts/` (end-to-end checks).

## Making a change

1. **For anything bigger than a fix, open an issue first,** so we agree on the approach before you spend time on it.
2. **Keep pull requests focused.** One change, with its tests and docs.
3. **Test what you change:**
   - unit tests live next to the code: `packages/*/test`, `apps/web/test`, `action/test`, `scripts/test`;
   - a change in what the browser, git or the Action does gets a check in the matching `scripts/e2e-*.mjs`;
   - `npm run verify` must pass, and CI runs it on every pull request.
4. **Match the code around you:**
   - strict TypeScript;
   - comments that explain *why*;
   - names that say what a thing is.
5. **No new runtime dependencies without talking about it first.** The CLI is meant to stay small and MIT-licensed. The STEP reader (LGPL) is deliberately an optional install.
6. **Fixtures are generated, never edited by hand.**
   - `npm run fixtures` rebuilds `fixtures/`.
   - `scripts/make-step-examples.mjs` rebuilds the STEP files (its header says how).
7. **Update the docs a user would read:**
   - the README for behaviour and options;
   - `docs/` for the Action, the merge rules and the security design.

`DEVLOG.md` is the maintainer's log of decisions (numbered D1, D2, …). You don't need to edit it.

## Changelog and releases

Every change a user would notice adds a line to [CHANGELOG.md](CHANGELOG.md), under `## Unreleased`, in the right group:
- **Added**: new features.
- **Changed**: changes in existing behaviour.
- **Fixed**: bug fixes.
- **Removed**: removed features.

Releases are made by the maintainer, in two steps:
1. **Prepare.** In the Actions tab, run **Prepare release** with the new version (for example `0.3.0`). It opens a pull request that sets every package to that version and moves the Unreleased notes under it. (`node scripts/release.mjs prepare 0.3.0` does the same locally.)
2. **Merge that pull request.** The **Release** workflow then runs `npm run verify` and, only if that passes:
   - publishes both npm packages;
   - tags the release and writes its GitHub Release from the changelog;
   - moves the Action's `v1` tag to it.

## Licence

polymerge is MIT-licensed ([LICENSE](LICENSE)). By contributing, you agree that your contribution is licensed under the MIT licence too.
