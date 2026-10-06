# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. On this repository, open the **Security** tab and choose **Report a vulnerability** (GitHub's private vulnerability reporting).

A useful report includes:
- what you did;
- what happened;
- the polymerge version (`polymerge --version`, or the Action's ref);
- the model file or link that triggers it, if there is one.

polymerge is maintained by one person. The aim is to acknowledge a report within a week, and to fix a confirmed problem in the next release, sooner for a serious one. You'll be credited in the release notes unless you'd rather not be.

## Supported versions

Fixes go into the latest release only:
- `@joshuahurley/polymerge` and `polymerge-core` on npm;
- the `v1` tag of the GitHub Action.

polymerge is at version 0.x, so upgrading to the latest release is how you get a fix.

## What polymerge must keep safe

- **Model files are untrusted input.** Reading, diffing or merging one must not run code, touch any file other than the ones named, or reach the network. One exception is the hosted viewer's optional STEP reader, which downloads only after you agree. A model too large for its limits is refused or listed, not processed.
- **The local viewer server** (`polymerge view`, `review`, `demo`) serves only its own files and the models it was given. It checks the `Host` header on every request.
  - Writing happens only through `polymerge review`'s "Save to repository": one conflicted file, with a per-session token, on a loopback address only.
  - The design and its threat model: [docs/write-back-security.md](docs/write-back-security.md).
- **The pull-request Action** renders a pull request's models without running its code. The step that posts the comment treats the render step's output as untrusted. Details: [docs/github-action.md](docs/github-action.md#security).
- **The hosted viewer** (<https://joshua080.github.io/polymerge/>) opens models from other sites in your browser only; nothing is uploaded. The OpenCascade files for STEP are checked against pinned SHA-256 fingerprints before they run.

These are not vulnerabilities:
- A merge result that is geometrically wrong but harmless (please open an issue).
- The cost of a deliberately huge model within the limits you configured.
- Problems in OpenCascade (`occt-import-js`) itself, which belong to [its project](https://github.com/kovacsv/occt-import-js). Do tell us if polymerge uses it unsafely.
