---
id: 46
title: Complete `rev-parse` revision syntax
blocked-by: []
---

# 46 — Complete `rev-parse` revision syntax

**Summary.** Tier A. `revParse()` resolves refs, oids and `~`/`^` chains only.
Peeling to a type, reading a path out of a revision, and asking whether a
revision exists have no spelling. The orchestrator issues all three on its
checkpoint path: `<snap>^{tree}`, `--verify --quiet <snap>^{commit}`, and
`HEAD:<lockfile>`.

## Problem

`Repository.revParse()` (`src/core/repository.ts:279`) documents its own subset:
"a ref, a full or abbreviated oid, and the `^`, `^N` and `~N` suffixes,
chained". Everything else throws `RefNotFoundError`. Three gaps matter in
ordinary tooling:

- **Peel to a type.** `<rev>^{commit}`, `<rev>^{tree}`, `<rev>^{}` are not
  parsed — the suffix loop reads the `^`, applies "first parent", then rejects
  the `{`. A caller who wants a commit's tree oid must read the commit object and
  take `.tree`.
- **Path inside a revision.** `<rev>:<path>` resolves in `catFile()` only, and
  that returns bytes. A caller who wants the *oid* of a path at a revision has to
  materialise its content to get it.
- **Existence probe.** There is no `--verify --quiet` equivalent, so "does this
  ref exist" is spelled as a caught exception. Control flow through `throw` is
  the pattern every other read on this surface avoids.

`<a>..<b>` ranges are deliberately **out of scope** here — they belong with the
bounded `revList` in [39](39-plumbing-read-surface.md).

## Approach / acceptance

- Add `^{}`, `^{commit}`, `^{tree}`, `^{blob}` and `^{tag}` with Git's
  semantics: peel to the named type, error when the object cannot peel to it,
  and keep the suffixes chainable in any order the parser already allows.
- Add `<rev>:<path>` resolution returning the entry oid and mode, over the same
  bounded tree read `catFile()` already uses. A path that is a directory
  resolves to its tree.
- Add a non-throwing existence form — an option, or a sibling `tryRevParse()` —
  returning `undefined` instead of throwing, and route the internal callers that
  currently catch onto it.
- Real Git parity tests per suffix against real `git rev-parse`: an annotated
  tag peeled to a commit and to a tree, a commit peeled to a tree, a blob path,
  a directory path, a path that does not exist, a chained suffix
  (`<tag>^{}~2^{tree}`), and a type mismatch.

## Touch points

`src/core/repository.ts`, `src/core/ops/reads.ts`, `src/git/client.ts`,
`src/compat/computer/client.ts`, `tests/reads.test.ts`,
`tests/git-upstream-parity.test.ts`, `docs/reference/git-support.md`

<!-- Origin: docs/reference/git-support.md#reference-workload-coverage -->
