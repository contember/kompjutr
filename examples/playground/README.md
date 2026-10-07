# kompjutr playground

A local browser IDE over the full Next.js v15.5.2 source tree: 24,252 tracked
files. Editor, search, Git controls, and terminal use the same SQLite-backed
workspace inside one local workerd Durable Object.

## Run

Requires Node.js 24, npm, and Git. Install the root dependencies first.

```bash
npm ci
npm --prefix examples/playground ci
npm --prefix examples/playground run dev
```

Open <http://127.0.0.1:4173>. On first launch, click **Clone Next.js into the
workspace**. The runner reuses the benchmark fixture in `bench/.fixtures/nextjs`
or downloads and prepares it if missing. It serves that fixture through a local
Smart HTTP origin; kompjutr performs the clone into its own database.

The default fixture preserves the full upstream file tree but rebuilds history
as one commit. To load the real upstream history instead, stop the server and run:

```bash
npm --prefix examples/playground run dev:history
```

This mode prepares a bare upstream clone at the pinned v15.5.2 revision, without
a depth limit or blob filter, and serves all history reachable from that revision
through the local Smart HTTP origin. Other upstream branch tips and release tags
are not mirrored. The first download requires `cpu-lease` and reserves two CPUs.
kompjutr then uses `blob:none` with no depth limit to import every reachable
commit and tree into SQLite when you click **Clone Next.js into the workspace**.
It hydrates all files for the initial checkout. Historical file contents are
fetched from the cached local origin when needed and retained in SQLite.
The history panel pages the first-parent chain; terminal `git log` also
traverses merged branches, and `git show <commit>` lazily loads the contents
needed for the historical patch.

The upstream origin contains 30,347 commits and 559,670 packed objects. Pack
ingest bounds its physical-offset, completion, and delta-depth arrays to 16 MiB;
an unfiltered pack from this source needs about 6.94 MiB for those arrays. The
first SQLite import processes every historical tree, so it does substantially
more work than the single-commit fixture.

Verified locally against native Git: all 30,347 commits persist after a Worker
restart, the checkout contains 24,252 files at upstream commit
`497ec6aa08a33f9e2d65a5c8461f550c2549d3e6`, history pagination reaches the
first-parent root, and historical patches load through the promisor origin.

One instrumented local import under `cpu-lease run -n 2` took 362 seconds,
issued 31,880 SQL statements, and returned 4,918,719 rows. With no cgroup memory
cap, peak workerd RSS was 1.52 GiB and sampled V8 used + external memory reached
1.46 GiB. RSS is not isolate memory; the GC-sampled V8 value is a lower bound.
This import does not fit the production 128 MB Durable Object memory limit.

A full-blob history import currently stops with `ECORRUPT: delta working set
exceeds 48 MiB`. Delta reconstruction holds the base and target together under
that limit; the upstream history includes native SWC binaries above 40 MiB.
The history mode uses Git's blobless clone to import the full commit history
without eagerly reconstructing every old binary.

The history workspace persists separately in `.state/full-history/`; the original
fixture workspace stays in `.state/`. Switch modes by restarting with `dev` or
`dev:history`. The cached bare origin is in `.state/origins/nextjs-v15.5.2.git`.

SQLite persists in `examples/playground/.state/`. Stop and restart the server to
keep files, branches, commits, and shell cwd. Browser reload also preserves saved
state. Unsaved editor drafts and terminal output belong to the current browser
page. Command history is stored in the browser's local storage.

Ports: Vite on 4173, the local Worker on 8787, and the Git origin on 8788, all
bound to loopback. The Git origin's stable URL preserves lazy blob loading
across restarts. This is a local example, not a public deployment configuration.
Local workerd does not enforce Cloudflare's production isolate memory limit.

Vite reloads frontend changes. Restart `dev` after changing Worker code; the
runner bundles it once at startup.

## Demo sequence

1. Search for `NextRequest`, then open a source file from the results.
2. Run `git switch -c demo` in the terminal.
3. Edit the file and save with the toolbar or Ctrl/Cmd+S.
4. Open **Changes**, inspect the diff, and stage the file with **+**.
5. Enter a message and click **Commit staged**, or use the terminal:

   ```sh
   git add .
   git commit -m "Update source documentation"
   git log --oneline -n 3
   ```

6. Switch between `main` and `demo` using the branch selector. The open file
   updates to the checked-out contents.
7. Reload the browser or restart the server to show persistence.

The footer reports browser-observed request round-trip time, SQL statement
count, and rows **returned**, not rows scanned. These are live operation
diagnostics, not benchmark results. Follow `bench/CLAUDE.md` for benchmarks.

## Implementation

- React + CodeMirror 6 editor; xterm.js terminal with an integrated prompt,
  readline editing, arrow-key history, multiline paste, and Ctrl+C to discard
  the current input. Ctrl+L clears the screen.
- Paginated directory loading, SQLite-native literal content search, and paged
  first-parent commit history.
- Typed Git controls call `workspace.git`; the terminal composes `createShell`
  with `createGitCommand` over the same filesystem and Git client.
- Requests are serialized per workspace. Saves compare file versions and reject
  stale buffers. Terminal changes refresh saved editor contents and preserve
  conflicting unsaved drafts.
- Terminal output appears as soon as the command returns, before refreshing the
  Git panel. Explorer and search refresh only when the filesystem revision changes,
  so read-only commands do not trigger another repository-wide search.
- The editor accepts UTF-8 regular files up to 512 KiB. Large search candidates
  are identified explicitly. Use the terminal to inspect larger or binary files.
- The shell implements kompjutr's documented command subset. It does not run
  Node, npm, development servers, or interactive OS processes.

## Checks

```bash
cpu-lease run -n 2 -- npm --prefix examples/playground run typecheck
cpu-lease run -n 2 -- npm --prefix examples/playground test
cpu-lease run -n 2 -- npm --prefix examples/playground run build
npm run check
```

The focused suite runs against local workerd and a real Git HTTP origin. It
checks editor/shell/Git parity, cold persistence, history pagination, lazy
historical patch hydration after an origin restart, stale-save protection,
directory/search pagination, and boundary failures.
