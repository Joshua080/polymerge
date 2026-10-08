# Saving from the merge review — security design

Status: written and committed before any of the feature's code. The implementation follows this document; where a detail had to change while building it, the change is recorded here too. The code is in `packages/cli/src/`:
- `serve-guard.ts`: the `Host` / `Origin` / token checks and the static allowlist;
- `review-api.ts`: the two HTTP routes;
- `write-back.ts`: path validation, the recomputed file, the rechecks, the atomic write and `git add`.

The viewer side is in `apps/web/src/merge-app.ts`.

## The feature, and why it needs a threat model

`polymerge review <path>` opens the merge review on a conflicted `git merge` of a model: a small local web server serves git's three index stages (`:1` ancestor, `:2` ours, `:3` theirs) to the viewer, and the reviewer resolves the conflicts by clicking. Until now the review could only *download* the result or show the `polymerge resolve <path> --pick …` command to run.

The new feature is a **Save to repository** button: it writes the resolved model to `<path>` and runs `git add <path>`, so the merge only needs a `git commit`. It never commits.

That turns a read-only local server into one that **writes a file and runs git**. A local HTTP server is reachable by more than the person who started it: every web page open in their browser can send requests to `127.0.0.1`, and on a shared machine every other account can connect to loopback ports. A write endpoint reachable by those parties, and not tied to one path, would be an arbitrary-file-write primitive: `~/.bashrc`, `.git/hooks/*` or `~/.ssh/authorized_keys` are one write away from code execution.

The goal is that the capability can be used only:
1. by the person who started the session,
2. for the one file they named on the command line,
3. with a result they have seen and fully resolved,
4. without destroying anything they changed in the meantime.

---

## 1. Assets

| Asset | What could go wrong |
|---|---|
| **Every file the user can write** | A write that can be aimed anywhere is arbitrary file write, which is code execution (shell rc files, git hooks, SSH keys). |
| **The repository's index** | `git add` marks a conflict resolved. Adding an unresolved or wrong result lets it be committed as if reviewed. |
| **The conflicted model, and the user's own edits to it** | Clobbering changes made to the file after the review started (in an editor, or by `polymerge resolve` in another terminal). |
| **The model data the server holds** | Confidentiality. The models may be proprietary CAD. The server keeps the bytes in memory and serves them to anyone who asks it correctly — *already true today*, for `view` and `review`. |
| **The session token** | Holds the write capability for the session. |

## 2. Attackers

| # | Who | What they can do |
|---|---|---|
| A1 | **A web page on another origin** open in the user's browser: a malicious or compromised site, an ad. | Make the browser send requests to `http://127.0.0.1:<port>`: form posts, `fetch`, `<img>`, `<script>`. It cannot *read* cross-origin responses unless the server allows it with CORS, and it cannot add custom headers or a JSON content type without a CORS preflight. It can guess the default port (5178) and probe others. |
| A2 | **A DNS-rebinding page.** `attacker.example` first resolves to the attacker's server, then to `127.0.0.1`. | The page's requests to `http://attacker.example:5178` now reach our server, and they are *same-origin* for the page, so it can read the responses. The only thing that tells them apart from the real viewer's requests is the `Host` header (`attacker.example:5178`). |
| A3 | **Another account on the same machine.** | Connect to any loopback port. Cannot read the user's files or process memory. Can usually list process command lines (`ps`, `/proc/*/cmdline`). |
| A4 | **Another process running as the same user.** | Anything the user can do: read and write the repository, run git, read the terminal, attach to the browser. No server-side check changes what it can do. |
| A5 | **Someone on the network.** | Reach the server only when it listens on a non-loopback address (`--host`). |
| A6 | **Hostile repository content.** The branch being merged may come from someone else, and so may the file names and model bytes. | Choose file names (e.g. `*.stl`, `-x.stl`, `a.html`) and model contents. |
| A7 | **The user, by mistake.** Not an attacker, but the most likely source of damage. | Save a merge with conflicts left at base, save over their own later edits, save a result that differs from what they looked at. |

## 3. Entry points

| Entry point | Before this change | After |
|---|---|---|
| `GET /` and the viewer's static files | Path arithmetic on the decoded URL path, with a prefix check. | Exact lookup in an allowlist built at startup (§4.9). `Host` checked. |
| `GET /models/<side>/<name>` | The served models, from memory. No checks. | `Host` checked; model content types only; a random per-session path segment (§4.9). |
| `GET /vendor/occt-import-js/<file>` | — | Added with STEP support: the user's installed OpenCascade reader, four fixed file names (§4.9). `Host` checked. |
| `GET /api/review/session` | — | New, `review` only: what the session can save. Token, `Host`, fetch metadata. |
| `POST /api/review/save` | — | New, `review` only: save and stage. Every check in §4. |
| Any other request | 404 | 404 (after the `Host` check). |
| The URL handed to the browser | Printed; passed to the OS launcher (`xdg-open`, `open`, `cmd /c start`). | Also carries the token, in the fragment (§4.3). |
| The CLI: `polymerge review <path> [--host] [--port]` | | The only place the target path comes from. |
| git subprocesses | `git show :n:<path>` | `rev-parse`, `ls-files`, `cat-file`, `add` (§4.7). |
| The file system at `<path>` and its parent directory | Read by git only. | Read, hashed, replaced by rename (§4.6). |

---

## 4. Threats and mitigations

### 4.1 Other websites in the user's browser (A1): cross-site request forgery

**Threat.** A page anywhere does
`<form method="POST" action="http://127.0.0.1:5178/api/review/save" enctype="text/plain">`, or `fetch(…, { mode: 'no-cors', method: 'POST' })`, and the browser delivers it. The page never sees the response, but a *blind* write would be enough.

**Mitigations.** Each one alone stops the blind write; they are layered on purpose.
1. **A required custom header carries the token:** `X-Polymerge-Token`.
   - The page cannot know the token (§4.3).
   - A custom header makes the request "non-simple". The browser first sends a CORS preflight (`OPTIONS`) and sends the real request only if the server approves. **The server never sends any `Access-Control-Allow-*` header, on any route**, so the preflight always fails and the POST is never sent.
   - `mode: 'no-cors'` requests silently drop non-safelisted headers, so they arrive without a token.
2. **`Content-Type: application/json` is required.** That is not a CORS-safelisted type either (another preflight trigger), and HTML forms cannot send it.
3. **`Origin` is required on the POST and must be the server's own loopback origin:** `http://127.0.0.1:<port>`, `http://localhost:<port>` or `http://[::1]:<port>`. Browsers always send `Origin` on a POST. This also rejects:
   - another local web server (a different port is a different origin);
   - `Origin: null` (sandboxed frames, `file://` pages).
4. **`Sec-Fetch-Site`, when present, must be `same-origin`.** All current browsers send it.
5. **No ambient credentials.** The token is not a cookie, so the browser never attaches it on its own. Ambient credentials are the root cause of CSRF, and there are none.

**Reads.** A1 cannot read any response: there are no CORS headers. Every response also carries `Cross-Origin-Resource-Policy: same-origin`, so an `<img>` or `<script>` pointing at `/models/…` from another origin gets nothing delivered.

**Clickjacking.** A1 could frame the viewer and trick a click on Save. But the Save button exists only on a page that holds the token, and A1 cannot build that URL. On top of that, every response sends `Content-Security-Policy: frame-ancestors 'none'`.

Chrome's Private Network Access adds a further preflight for public-to-loopback requests. The design does not rely on it.

### 4.2 DNS rebinding (A2)

**Threat.** After rebinding, the attacker's page is same-origin with our server under the attacker's name, so the same-origin policy no longer protects the responses. Today, before this change, such a page can already `GET /models/base/<name>` and read the user's models in any `view`, `review` or difftool session. With a write endpoint it could also try to save.

**Mitigation: the `Host` header is checked on every request, on every route** (static files, models and the API), before anything else happens.
- **Read routes** accept only `localhost` or an IP literal, with the server's own port.
  - A rebinding page's requests carry `Host: attacker.example:5178` and get a 403 before anything is read.
  - IP literals are allowed so that the existing `--host 0.0.0.0` use (viewing from another machine by IP, read-only) keeps working. An IP literal cannot be rebound: rebinding needs a DNS name.
  - Other names (`myhost.local`, `*.localhost`) are refused.
  - A request with no `Host` (HTTP/1.0) is refused.
- **API routes** accept only `localhost` or a *loopback* literal (`127.0.0.0/8`, `::1`), with the server's port. The connection's own remote address must be loopback too (§4.4).

A page on another local server (`http://localhost:3000`) is a different origin, not a rebinding case, so §4.1 covers it.

### 4.3 The token

**Generation.** 32 bytes from `crypto.randomBytes` (the OS CSPRNG), base64url-encoded (43 characters).
- It is new for every `polymerge review` process.
- It is never written to disk and dies with the process.
- Guessing 256 bits is not a concern, so there is no lockout.
- The merge (the one expensive operation) runs only after the token has been checked.

**Comparison.** Both the given and the expected token are hashed with SHA-256, and the digests are compared with `crypto.timingSafeEqual`. That is constant-time and independent of the given token's length.

**Delivery: in the URL fragment**, `http://127.0.0.1:<port>/?mode=merge&…#token=<token>`, not the query.
- Fragments are never sent in HTTP requests, so the token is never in a request line, a server log or a proxy log.
- Fragments are never included in `Referer`. Every response also sets `Referrer-Policy: no-referrer`.
- The page reads the fragment once and removes it from the address bar immediately (`history.replaceState`). It keeps the token in memory, plus in `sessionStorage` (per tab and per origin) so that reloading that tab keeps the Save button.
- The token is sent back to the server only in the `X-Polymerge-Token` header, and only on same-origin `fetch`es.

**Where it is still visible, honestly:**
- **The terminal**, which prints the URL so that `--no-open` users can open it. That is the user's own terminal.
- **The OS launcher's command line** (`xdg-open <url>`, `open`, `cmd /c start`), and the browser's own command line if the browser was not already running. Another account (A3) can read those with `ps` while those processes are alive. **On a shared machine, use `--no-open` and paste the URL.**
- **Browser history** may keep the first URL, fragment included. That token stops working when the server exits. A later session on the same port has a new token.

**What the token protects against:**
- A1 and A2, which can never learn it;
- A3 connecting to the loopback port and posting, unless they caught it in `ps` (above);
- A5, which additionally never gets a write-capable server at all (§4.4).

**What it does not protect against:**
- **A4, a process running as the same user.** It can read the terminal or the browser's memory, or simply write the file and run `git add` itself. The token adds nothing against A4, and this design does not pretend otherwise.
- **Its own holder.** A token holder can do what the Save button can do, and no more (§4.5): choose ours, theirs or base per conflict, for the one file, once. That is the ceiling of a leaked token.

**"One-time".** The token is generated once per session and never reused by another session. The *write* it authorises is one-time: after one successful save the conflict is resolved, and the endpoint answers 409 from then on. The token is deliberately not rotated per request: a failed save (for example `.git/index.lock` held by another git command) must be retryable without restarting the review.

### 4.4 Binding (A5)

**Today.** `--host` defaults to `127.0.0.1`, but accepts any address; `--host 0.0.0.0` exposes the viewer to the network.

**Decision: a non-loopback bind never enables writes.**
- The write routes exist only when the socket *actually* bound to a loopback address. This is checked from `server.address()`, not from the flag's spelling: `--host localhost` may resolve to `127.0.0.1` or `::1`.
- With any other address, `review` runs read-only: no token in the URL, no `/api/review/*` routes (404), and a notice on stderr.
- There is no flag to override this.
- Independently, the API routes check that the connection's remote address is loopback.

The non-loopback, read-only viewer remains possible, as before, now with the `Host` check of §4.2.

### 4.5 What the browser sends: resolution choices, never bytes or paths

**Decision: the browser sends only the choices.** The request body is exactly:

```json
{ "picks": { "0": "theirs", "1": "base" }, "acknowledgeWarnings": false, "expect": "<sha-256 hex>" }
```

- `picks` maps each conflict id to `ours`, `theirs` or `base`. Ids must exist in the merge; there must be no duplicates and nothing else.
- `acknowledgeWarnings` is the reviewer's explicit "save anyway" for collision warnings (§4.8).
- `expect` is the SHA-256 of the file the viewer would write (see below).
- **Any other field is a 400.** There is no field for a path, a format or file content. A body that tries to name a path or carry bytes is refused, not ignored.

**The server recomputes the file.** It merges the three stage blobs it read when the session started (the same bytes it served to the viewer) with those picks, through the same function `polymerge resolve` uses. It writes with `writeMesh`, in the format given by the path's extension. The saved file is **byte-for-byte what `polymerge resolve <path> --pick …` writes**, and the end-to-end test checks exactly that.

**For:**
- A stolen token can only choose between versions that already exist in the repository's index. It cannot write arbitrary bytes, choose a format, or name another file. The worst case is what the user could have clicked.
- One code path for the CLI and the browser, so they cannot drift (the same principle as D20).
- No upload and no mesh parsing of request data on the server.

**Against, and the answers:**
- **Cost.** The server recomputes the merge, which takes about as long as the viewer's merge did (around 1–2 s at 100k vertices). That is fine for a button press, and it runs only after authentication.
- **Divergence.** The browser's merge could differ from Node's: a different JavaScript engine can round `Math.sin` or `Math.atan2` differently in a Tier 3 alignment, or the tab may be showing other models than the session's (the viewer also accepts dropped files).
  - The `expect` digest catches this. The viewer hashes the exact file it would write: `writeMesh` of the model on screen, in the session's format and name.
  - The server compares that with the SHA-256 of its own bytes and refuses with 409 on any mismatch.
  - So **the file written is exactly the one the reviewer saw, or nothing is written.**
  - The digest is a consistency check, not an authenticator: anyone holding the token can compute it.

### 4.6 Path validation

**The path is fixed at startup, from the CLI argument, and never taken from a request:**
1. `git rev-parse --show-toplevel` in the current directory gives the work-tree root. Its `realpath` is kept.
2. The argument is resolved against the current directory. Its **parent directory** is `realpath`ed, and the target is `<real parent>/<basename>`.
   - It must lie inside the root: the relative path must not start with `..` and must not be absolute.
   - This also makes `review` work from a subdirectory. Before, the stages were looked up relative to the repository root.
3. The root-relative path (with `/` separators) must match an **unmerged index entry exactly**, from `git --literal-pathspecs ls-files -u -z -- <path>`.
   - Stages 1, 2 and 3 must all be present, each with a regular-file mode (`100644` or `100755`).
   - `--literal-pathspecs` matters. Without it, a file named `*.stl` is a *glob*: `git ls-files -- '*.stl'` lists every STL in the repository, and so would `git add`. Checked while writing this document.
4. The work-tree file must exist and be a regular file. `lstat` is used, so a symlink is refused, never followed.
5. Recorded for the session: the root, the index path, the parent's realpath, the three stages (mode, object id, bytes), and the SHA-256 of the file's current contents.

If step 1, 2 or 3 fails, `review` fails as it does today ("not an unresolved merge conflict"). If only the write conditions fail (step 3's modes, step 4, an unwritable format, a non-loopback bind), the review still opens, read-only, and says why.

**Rechecked at save time.** This happens *after* the new content is already in the temporary file (§ below), immediately before the rename, to keep the window small:
- `realpath(parent)` must still equal the recorded one. A parent directory swapped for a symlink, or moved, is refused.
- `lstat(file)` must still be a regular file. A symlink put in its place is refused.
- **The file's SHA-256 must still equal the recorded one.** The user's own edits, or a `polymerge resolve` run meanwhile, are never clobbered; the save answers 409 with a message.
- The index must still have the same three stages. A conflict already resolved (`git add`, `git checkout --ours`, `git merge --abort`) is refused.

**Atomic write:**
1. The bytes are computed completely in memory first. An unwritable format, or any writer error, fails before a file is touched.
2. A temporary file is created **in the same directory**, named `.<basename>.polymerge-<random>.tmp`, with `O_CREAT | O_EXCL` (`wx`) and mode `0600`. Exclusive creation fails on *any* existing path, including a planted symlink, so it never writes through a link.
3. It is written, `fsync`ed, and given the original file's permission bits.
4. It is `rename`d over the target. `rename` replaces the directory entry: if the target were swapped for a symlink in the last microseconds, the *link* is replaced, not the file it points to. Readers never see a half-written model.
5. On any error, the temporary file is removed and the original is untouched.

Accepted consequences of replacing by rename:
- The file gets a new inode. Hard links to the old file keep the old content; git never creates hard links in a work tree.
- Ownership, ACLs and extended attributes are not carried over. The user owns both files.
- On Windows, the rename fails if another program holds the file open. That is reported, and nothing is written.

**Case-insensitive file systems** (macOS, Windows).
- The file written is always `<root>/<index path>`, and the index entry must match the argument *exactly*.
- `review PART.stl` when the index has `part.stl` is refused, not guessed.
- There is no case folding anywhere, so no way for two spellings to name different files.

**Residual.** Between the final recheck and the rename there is a window of microseconds. Node has no `openat`/`renameat`, so the directory cannot be pinned by handle. Only A4 can race it, and A4 can write the file directly anyway.

### 4.7 Running git

- **`execFile('git', [args])`**: never a shell, the arguments are an array, and there is no string interpolation.
- **`--literal-pathspecs`, and `--` before the path.** A path starting with `-` cannot become an option, and glob characters are not patterns (§4.6).
- **The working directory is the work-tree root**, and the path is root-relative.
- **Only these commands run:**
  - `rev-parse --show-toplevel`;
  - `ls-files -u -z` (NUL-separated, so names with tabs or newlines parse exactly);
  - `cat-file blob <object id>`, with the id taken from `ls-files`;
  - `add`.

  Never `commit`, `checkout`, `reset`, or anything else. `git add` runs no hooks. Clean filters the user configured run just as they would for a manual `git add`.
- **Bounded:** a timeout and a maximum output size on every call.
- **If `git add` fails after the write:**
  - The file on disk is the saved result, and the index still marks the path conflicted.
  - The response says so (`written: true, staged: false`) with git's message. The viewer shows "Saved, but not staged", git's message, and the `git add <path>` to run.
  - The recorded content hash is updated to the new bytes, so the user can fix the cause (typically a stale `index.lock`) and press Save again.
- **After `git add`**, the server checks that `ls-files -u` is empty for the path before it reports success.

### 4.8 Semantics: never mark an unresolved merge as resolved

- **Every conflict needs an explicit choice** (ours, theirs or base), and the result must be clean. Otherwise the answer is 422 and nothing is written.
  - Saving with regions left at base and then `git add`ing would mark the conflict resolved while those regions silently stayed at base. That is exactly what must not happen.
  - Choosing *base* explicitly is a real decision, and it is allowed.
- **Collision warnings** (combined resolutions that damage the model; the git driver stops on them, D18). Saving needs `acknowledgeWarnings: true`, and the viewer sends it only after the reviewer ticks "save anyway". Because of the `expect` digest, the acknowledgement is bound to exactly that result.
- **The viewer enables Save only when every conflict is resolved.** The server enforces it anyway: the UI is not a security boundary.
- **Nothing is committed.** The viewer suggests `git commit`.
- **One successful save per session** (§4.3).
- **The download and "copy command" paths stay.** They are the fallback whenever saving is unavailable or refused.

### 4.9 The static-file route and the model route

**Static files.** Today: `path.resolve(webDist, '.' + decodeURIComponent(pathname))`, then a prefix check. Reviewed:
- **Encoded dots** (`%2e%2e`) are turned into `..` by the URL parser and normalised away before the handler sees them.
- **`%2f` and `%5c`** decode to `/` and `\` *after* URL parsing. `\` is a separator on Windows. `path.resolve` then walks up, and only the prefix check stops it.
- **Windows drive letters** (`/C:/…`) and NTFS stream names (`a:b`), NUL bytes, and malformed escapes (which make `decodeURIComponent` throw).

The prefix check catches all of these today. But it is path arithmetic on attacker input, and one refactor away from a traversal bug.

**Replaced with an allowlist.** At startup the server walks the viewer's directory, keeping regular files only and following no symlinks. It serves exactly those relative paths, by exact lookup. Any other request path is a 404, and nothing derived from a request is ever passed to the file system. The tests keep the hostile paths above as regression cases.

**Models:**
- They are served from memory by exact path.
- Content types are limited to the model types (STL, OBJ, glTF, GLB, 3MF, STEP); anything else, PLY included, is `application/octet-stream`.
  - Before: a path ending in `.html` (`view a.html b.html`, or `--name x.html`) would have been served as `text/html` on the viewer's origin, i.e. script running on the origin that holds the token (A6).
  - All responses also send `X-Content-Type-Options: nosniff`.
- **Model URLs carry a random per-session segment:** `/models/<random>/<side>/<name>`.

**The STEP reader** (`/vendor/occt-import-js/`) is served only when `occt-import-js` is installed. It is a second allowlist of four fixed names: the loader script, its wasm, and the two licence texts. Each is mapped at startup to a file in the package's `dist/` directory, so no request path reaches the file system here either. The script runs on the viewer's origin, like the viewer's own scripts. It is the copy the user installed, or the one `$POLYMERGE_OCCT` names, which the user has to trust as much as polymerge itself.
  - Another account (A3) connecting to the port can no longer fetch the models without the URL. Before, the paths were predictable.
  - This is a small, honest improvement for shared machines, with the same `ps` caveat as the token (§4.3).

**Headers on every response:**
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`;
- `Cross-Origin-Resource-Policy: same-origin`;
- `Content-Security-Policy: frame-ancestors 'none'`.

Models and API responses also send `Cache-Control: no-store`.

### 4.10 Denial of service

- The request body is at most 64 KiB. A larger body gets 413. `Content-Length` is checked before reading, and reading stops at the limit.
- The token is checked before the body is parsed or any merge runs. Unauthenticated requests cost O(1).
- One save at a time: a concurrent save gets 409.
- A token holder can make the server merge repeatedly. They are the user.

---

## 5. Which sessions can write

| Session | Write-back |
|---|---|
| `polymerge review <path>`, bound to loopback | **Yes**, to `<path>` only. |
| `polymerge review <path> --host <non-loopback>` | No. Read-only, with a notice. |
| `polymerge view base target`, `polymerge view base ours theirs`, git difftool | No. |
| `polymerge demo` | No. |

**Should three-file `view` get an explicit `--write <path>`?** Not now.
- It could be made safe with the same machinery: the path fixed at startup by the CLI, the content hash, the atomic write, and no `git add`.
- But it would lack git's conflict state as a second witness. There would be no stages to check the served models against, and no "still conflicted" check.
- `polymerge merge … -o <file> --pick …`, which the viewer already shows, does the same job.

It is an open question for later, not part of this change.

## 6. Contract

`GET /api/review/session`. Needs the token header, a loopback `Host`, a loopback peer, and `Sec-Fetch-Site: same-origin` when present.

```json
{ "path": "parts/plate.stl", "name": "plate.stl", "format": "stl", "writable": true }
{ "path": "parts/plate.stl", "name": "plate.stl", "writable": false, "reason": "parts/plate.stl is not a regular file (symbolic link)" }
```

`POST /api/review/save`. Needs everything above, plus an allowed `Origin`, `Content-Type: application/json`, and the body of §4.5.

| Status | When | Written? |
|---|---|---|
| 200 | Saved and staged. `{ ok: true, written: true, staged: true, path, message }` | yes |
| 400 | Malformed JSON, an unknown field (e.g. `path`, `bytes`), an unknown conflict id, a bad side, a bad `expect` | no |
| 403 | `Host`, peer address, `Origin`, `Sec-Fetch-Site` or token check failed | no |
| 405 | Wrong method on an API route (including every `OPTIONS` preflight, which gets no CORS headers) | no |
| 409 | The file changed on disk, the parent directory changed, the target is no longer a regular file, the path is no longer conflicted, the viewer's result differs from the server's (`expect`), a save is in progress, or the session already saved | no |
| 413 | Body over 64 KiB | no |
| 415 | Content type is not `application/json` | no |
| 422 | Unresolved conflicts, unacknowledged collision warnings, or the session cannot write (format, file type) | no |
| 500 | Writing failed (nothing written), or `git add` failed after the write (`written: true, staged: false`) | only in the second case |

In `view` and `demo` sessions, and in `review` on a non-loopback bind, both routes are a plain 404.

## 7. Out of scope, and residual risks accepted

- **A4, processes running as the same user.** They can do everything the feature does without it.
- **The token in process command lines**, while the browser launcher (or a newly started browser) runs, visible to other accounts (A3). The mitigation is `--no-open` on shared machines, and it is documented.
- **A compromised browser or a malicious extension.** They can read any page, including ours.
- **Plain HTTP.** The traffic never leaves the machine, and sniffing loopback needs root.
- **Malformed or hostile model data crashing the parsers or the merge.** That is a robustness concern that already exists. It does not make writes reachable: the server writes only what the merge computed, and only after every check above.
- **git configuration the user chose** (filters, `core.*` settings). `git add` behaves exactly as it would from their shell.
- **The final-check-to-rename window** (§4.6), reachable only by A4.

## 8. How it is tested

Against the real server, with a real git repository (`packages/cli/test/write-back.test.ts`). Each attack must fail safely: an error status, the file unchanged, the index still conflicted, no temporary file left, and nothing written anywhere else.

| Threat | Test |
|---|---|
| §4.1 CSRF | A missing token; a wrong token; the token in the query, the body, a cookie or `Authorization`; a cross-origin `Origin`, `Origin: null`, no `Origin`; `Sec-Fetch-Site: cross-site`; a form-encoded (`text/plain`) POST; an `OPTIONS` preflight gets no `Access-Control-Allow-*` |
| §4.2 rebinding | A hostile `Host` on POST, and on GET for the page, the models and the session info |
| §4.4 binding | `review` bound to a non-loopback address has no write routes |
| §4.5 body shape | A body with a `path` field, with file bytes, an unknown conflict id, a bad side; a wrong `expect` |
| §4.6 paths | The target replaced by a symlink after startup; the parent directory replaced by a symlink after startup; the file modified on disk after startup (the edit is kept); the conflict resolved by someone else meanwhile |
| §4.7 git | `git add` failing after the write (a held `index.lock`) reports `written, not staged`, and a retry succeeds |
| §4.8 semantics | An unresolved merge (no picks, some picks); collision warnings without and with the acknowledgement; a second save is refused |
| §4.9 static | Encoded dots, encoded slashes and backslashes, drive letters, NUL and double encoding all 404, and never return a file outside the viewer |
| §5 sessions | The routes are absent (404) in `demo` and in `view` |
| Unwritable format | A writer that throws leaves nothing on disk |

**Each defence is pinned by a test.** Removing any one of these makes at least one test fail: the token check, the `Host` check (all routes), the loopback-only `Host` rule of the write routes, the `Origin` check, the content hash, the parent realpath, the file-type check, the unresolved check, the warning acknowledgement, the digest, the unknown-field rule, the stage recheck, the loopback-only bind, and the model content types. This was checked by disabling each one in turn. The first run found one gap: the write routes' loopback-only `Host` rule was hidden behind the general check, so a non-loopback IP-literal `Host` case was added.

The happy path runs in real git (`scripts/e2e-git.mjs`): a conflicted `git merge`, then `polymerge review`, then a resolution in headless Chromium, then Save. It checks that the file on disk equals `polymerge resolve --pick …` output, that `git diff --cached` shows it staged, and that the path is no longer `UU`.

## 9. Decisions

| Decision | Why |
|---|---|
| The browser sends resolution choices only; the server recomputes the bytes from the stages it read at startup, through `polymerge resolve`'s code. | A leaked token can only pick between versions already in the index, never write chosen bytes or name a path. And the CLI and the browser cannot drift. |
| The viewer sends a SHA-256 of the exact file it would write; the server refuses on mismatch. | The file written is the one the reviewer saw, or nothing. This catches engine differences and stale tabs. |
| The token goes in the URL fragment and a custom request header, never in a query or a cookie. | Fragments never reach logs or `Referer`. A custom header forces a CORS preflight the server never approves. No cookie means no ambient credential to forge with. |
| The `Host` check applies to every route, not only the new ones. | DNS rebinding could already read the served models before this change. |
| A non-loopback bind never enables writes, with no override. | A network-reachable write endpoint is not worth any convenience it could buy. |
| The target path comes only from the CLI and must be an unmerged index entry with all three stages, matched with literal pathspecs. | The endpoint then has no way to reach any other file, and git's conflict state is a second witness that this is the file under review. |
| Content hash, parent realpath, `lstat` and stage checks run right before an atomic rename from an exclusive temp file. | The user's own edits are never clobbered, symlink swaps are refused, and a partial write is never visible. |
| All conflicts must be explicitly resolved; collision warnings need an explicit acknowledgement bound to the digest. | Staging a merge with regions silently left at base would record an unreviewed merge as resolved. Warnings follow D18. |
| The static route serves a startup allowlist, not paths computed from the request. | Traversal becomes structurally impossible instead of depending on a prefix check. |
| `view` and `demo` stay read-only; no `--write` flag for now. | Without git's conflict state there is no second witness, and `polymerge merge -o` already covers the case. |
