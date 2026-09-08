---
id: 70
title: Enforce local scan ordering and regular-file discovery
blocked-by: []
---

# 70 — Enforce local scan ordering and regular-file discovery

**Summary.** Fix statically verified local adapter contract violations reached
by ordinary scans, checkout planning, and ignore loading.

## Problem and evidence

### Directory rows disagree with cursor ordering

External sorting compares directories with a trailing slash, but `scanStream()`
emits their unsuffixed canonical paths. A directory `a` and file `a.txt` can emit
`/a.txt`, `/a`, `/a/file`, contrary to `comparePaths` on the emitted rows.
With an empty `/a`, a one-row page ending at `/a.txt` permanently skips `/a` on
continuation. Directory-inclusive checkout merge joins can also miss a directory
obstructing a target file. File-only traversal is not inherently affected.

### Discovery manufactures regular-file handles for symlinks

`discoverFiles()` uses `filesOnly`, which excludes directories but retains
symlinks. A stable in-root `.gitignore` symlink becomes a `RegularFileHandle`.
The reader correctly rejects its changed canonical path with `ESTALE`, which
ignore loading propagates to status/add. DO discovery explicitly selects regular
files instead.

Both mechanisms were independently traced in the review; neither received a
runtime reproduction. No hostile topology replacement is required.

## Approach / acceptance

- First reproduce scan page concatenation and a public status/add with a symlinked
  `.gitignore`; add native Git parity for the ignore behavior.
- Directory-inclusive scans must be ordered by their emitted canonical paths.
  Concatenating all pages must equal one complete stream, without omissions.
  Preserve correct file-only ordering and bounded traversal state.
- Cover hard reset from an obstructing directory `a` to tracked file `a`, with
  sibling `a.txt`, through public Git.
- Discovery returns regular-file handles only. Test regular, valid symlink,
  dangling symlink, and escaping symlink `.gitignore` entries. Keep symlinks in
  ordinary Git traversal.

## Touch points

- `packages/local/src/drive/external-sort.ts`, `disk-drive.ts`, `read.ts`.
- `packages/git/src/ops/checkout/checkout-structure.ts`.
- `packages/git/src/ignore/source.ts`.
- `tests/local/disk-scan.test.ts`, local discovery and Git parity witnesses.
