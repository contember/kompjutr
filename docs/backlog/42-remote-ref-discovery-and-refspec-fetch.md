---
id: 42
title: Add remote ref discovery and refspec fetch
blocked-by: []
---

# 42 — Add remote ref discovery and refspec fetch

**Summary.** Tier A. `fetch()` takes one branch selector, and the remote's
advertised refs are never surfaced, so a ref outside `refs/heads/*` can be
neither listed nor fetched.

## Problem

`FetchOptions` in `src/core/ops/network.ts` accepts `ref` / `remoteRef` — one
branch, by name. There is no refspec syntax at all: no leading `+`, no wildcard,
no destination namespace.

The advertisement is already parsed. `discover()` in
`src/core/protocol/remote.ts` returns every ref the remote offers, and
`src/core/ops/push.ts:117` reads it to find one old oid — but nothing exposes
it, so there is no `ls-remote` either.

Together that closes off a whole pattern: a caller that keeps its own state on
the remote under its own namespace (`refs/checkpoints/*`, `refs/backups/*`) can
neither enumerate what is there nor pull it back. The [reference
workload](../reference/git-support.md#the-reference-workload) rebuilds a lost
sandbox with exactly `fetch origin '+refs/checkpoints/*:refs/checkpoints/*'`
after listing the namespace with `ls-remote`.

Push has the mirror-image gap, tracked separately in
[08](08-extend-push-refspecs.md); the two share the refspec type and its
validation, so whichever lands first should define it.

## Approach / acceptance

- Export a bounded `lsRemote({ remote | url, patterns })` over the existing
  advertisement parse, with an explicit cap on returned refs and a stable error
  past it. No second network round trip when a fetch is about to run anyway.
- Accept typed refspecs on fetch: source pattern, destination pattern, force
  flag, bounded fan-out. Validate every local and remote ref name before the
  request is built.
- Expand wildcards against the advertisement, never against a guess. The
  expansion is capped and fails closed rather than truncating.
- Only a complete, validated pack may move destination refs, and every ref in
  one fetch moves in one transaction — a partially applied refspec set is not a
  reachable state.
- Real Git parity tests: one explicit refspec; a wildcard into a non-`heads`
  namespace; force versus non-fast-forward rejection; a pattern that matches
  nothing; `ls-remote` with and without patterns against a real server; and the
  ref cap.

## Touch points

`src/core/ops/network.ts`, `src/core/protocol/remote.ts`,
`src/core/protocol/transport.ts`, `src/git/client.ts`,
`src/compat/computer/client.ts`, `tests/protocol.test.ts`,
`tests/clone.test.ts`, `docs/reference/git-support.md`

<!-- Origin: docs/reference/git-support.md#reference-workload-coverage -->
